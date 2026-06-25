import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import aws4 from "aws4";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
// Both LLMs share the SAME endpoint — a single OpenAI-compatible client pointed
// at the AWS Bedrock gateway. The gpt-oss model accepts `temperature`, so the
// random-temperature behaviour below works as intended.
const MODEL = process.env.BEDROCK_MODEL || "openai.gpt-oss-120b";
const BASE_URL = process.env.BEDROCK_BASE_URL;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const PORT = process.env.PORT || 3000;
const GENERATE_EVERY_MS = Number(process.env.GENERATE_EVERY_MS || 25_000);
const MAX_CONTEXT_ITEMS = Number(process.env.MAX_CONTEXT_ITEMS || 40);
const CONTEXT_ITEMS_FOR_CHAT = Number(process.env.CONTEXT_ITEMS_FOR_CHAT || 15);

// Auth: a Bedrock API key is a bearer token. AWS access-key/secret are SigV4
// credentials and must be *signed* per-request — the OpenAI-compatible gateway
// rejects them as a bearer token ("401 Invalid bearer token"). So if no
// BEDROCK_API_KEY is set but AWS creds are, we sign every request with SigV4.
const BEARER = process.env.BEDROCK_API_KEY;
const AWS_CREDS = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  ? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN, // optional
    }
  : null;

if (!BASE_URL || (!BEARER && !AWS_CREDS)) {
  console.error(
    "\n  ✗ Bedrock config is missing.\n" +
      "    Copy .env.example to .env and set BEDROCK_BASE_URL plus either\n" +
      "    BEDROCK_API_KEY (bearer token) or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY,\n" +
      "    then restart.\n"
  );
  process.exit(1);
}

// SigV4-signing fetch: re-signs each OpenAI-SDK request with the AWS creds.
async function signedFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const headers = {};
  new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
  delete headers["authorization"];   // drop the SDK's bearer; SigV4 sets its own
  delete headers["content-length"];  // let fetch compute it
  const body =
    init.body == null ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);

  const signed = aws4.sign(
    {
      host: url.host,
      method: init.method || "GET",
      path: url.pathname + url.search,
      service: "bedrock",
      region: REGION,
      headers,
      body,
    },
    AWS_CREDS
  );
  delete signed.headers["Host"];          // forbidden header — fetch sets it
  delete signed.headers["Content-Length"];
  return fetch(url.toString(), { method: signed.method, headers: signed.headers, body });
}

const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: BEARER || "sigv4", // placeholder when signing; signedFetch ignores it
  fetch: BEARER ? undefined : signedFetch,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────────────────────
// Shared context store — everything LLM #1 produces lives here and becomes the
// context for LLM #2.
// ─────────────────────────────────────────────────────────────────────────────
/** @type {{ id:number, kind:string, topic:string, text:string, ts:number }[]} */
const contextStore = [];
let nextId = 1;
let generatorRunning = true; // toggled from the UI (Random Mind pause/resume)

function addToContext(kind, topic, text) {
  contextStore.push({ id: nextId++, kind, topic, text, ts: Date.now() });
  // keep only the most recent MAX_CONTEXT_ITEMS so memory stays bounded
  while (contextStore.length > MAX_CONTEXT_ITEMS) contextStore.shift();
}

function recentContextText() {
  const recent = contextStore.slice(-CONTEXT_ITEMS_FOR_CHAT);
  if (recent.length === 0) return "(the random mind is still warming up — nothing generated yet)";
  return recent
    .map((c) => `[${c.kind} about ${c.topic}]\n${c.text}`)
    .join("\n\n---\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM #1 — the endlessly creative generator
// ─────────────────────────────────────────────────────────────────────────────
const TOPICS = [
  "deep sea creatures", "the history of salt", "quantum entanglement", "medieval cheese",
  "the color blue", "lost civilizations", "the physics of skateboarding", "octopus dreams",
  "Victorian inventions", "the secret life of fungi", "desert mirages", "vintage typewriters",
  "the moon's hidden side", "tea ceremonies", "forgotten gods", "bioluminescence",
  "the number zero", "abandoned subway stations", "migratory birds", "the smell of rain",
  "ancient board games", "glaciers", "the language of bees", "haunted lighthouses",
  "origami mathematics", "volcanic islands", "the taste of memory", "clockwork automatons",
  "northern lights", "the sound of silence", "paper airplanes", "comets",
];
const FORMATS = [
  "a wildly surprising fact", "a short poem", "a tiny absurdist story",
  "a one-paragraph mock article", "a haiku", "an unhinged shower thought",
  "a fake but delightful proverb", "a micro-fable with a moral", "a riddle",
  "a dramatic monologue fragment",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function generateOnce() {
  if (!generatorRunning) return; // paused from the UI
  const topic = pick(TOPICS);
  const format = pick(FORMATS);
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 400,
      temperature: 1, // LLM #1 runs hot for maximum creativity
      messages: [
        {
          role: "system",
          content:
            "You are an endlessly creative muse. You produce short, vivid, original, " +
            "completely random creative writing. Never break character, never add " +
            "preamble like 'Sure' or 'Here is'. Just output the piece itself.",
        },
        {
          role: "user",
          content: `Write ${format} about "${topic}". Keep it under 120 words. Be strange and wonderful.`,
        },
      ],
    });
    const text = (res.choices?.[0]?.message?.content || "").trim();
    // Drop the result if generation was paused while this request was in flight.
    if (text && generatorRunning) {
      addToContext(format, topic, text);
      console.log(`  ✦ generated ${format} about "${topic}" (${text.length} chars)`);
    }
  } catch (err) {
    console.error("  ✗ generator error:", err?.message || err);
  }
}

// kick off the generator loop
console.log(`\n  Random ahh Chat — model: ${MODEL}`);
console.log(`  LLM #1 generating every ${GENERATE_EVERY_MS / 1000}s ...\n`);
generateOnce(); // immediate first one
setInterval(generateOnce, GENERATE_EVERY_MS);

// ─────────────────────────────────────────────────────────────────────────────
// Random temperature variable: 0–100 (with decimals), mapped to the API's 0–1.
// ─────────────────────────────────────────────────────────────────────────────
function randomTempVariable() {
  return Math.round(Math.random() * 100 * 100) / 100; // e.g. 73.42
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM #2 — the chatbot the user talks to
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const userMessage = (req.body?.message || "").toString().trim();
  if (!userMessage) return res.status(400).json({ error: "message is required" });

  const tempVariable = randomTempVariable(); // 0–100
  const apiTemperature = tempVariable / 100; // 0–1 for the Anthropic API
  const context = recentContextText();

  const system =
    "You are 'Random ahh Chat'. You answer the user's prompts, but your head is " +
    "stuffed full of random creative fragments that another mind has been " +
    "dreaming up. Let that swirling random context color your tone, metaphors and " +
    "tangents — weave bits of it in when it's fun — while still genuinely " +
    "responding to what the user actually asked.\n\n" +
    "=== RANDOM CONTEXT IN YOUR HEAD ===\n" +
    context +
    "\n=== END RANDOM CONTEXT ===";

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: apiTemperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    });
    const reply = (response.choices?.[0]?.message?.content || "").trim();

    res.json({
      reply,
      temperatureVariable: tempVariable, // 0–100, what the spec asked for
      apiTemperature, // 0–1, what was actually sent to the model
      contextItemsUsed: Math.min(CONTEXT_ITEMS_FOR_CHAT, contextStore.length),
    });
  } catch (err) {
    console.error("  ✗ chat error:", err?.message || err);
    res.status(500).json({ error: err?.message || "chat failed" });
  }
});

// Live peek at what LLM #1 has been dreaming up (for the sidebar feed)
app.get("/api/context", (_req, res) => {
  res.json({
    count: contextStore.length,
    running: generatorRunning,
    items: contextStore.slice(-CONTEXT_ITEMS_FOR_CHAT).reverse(),
  });
});

// Pause / resume LLM #1 from the UI.
app.post("/api/generator", (req, res) => {
  if (typeof req.body?.running === "boolean") generatorRunning = req.body.running;
  res.json({ running: generatorRunning });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL }));

app.listen(PORT, () => {
  console.log(`  ➜ http://localhost:${PORT}\n`);
});
