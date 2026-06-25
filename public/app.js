/* ============================================================================
   Random ahh Chat — front-end logic
   Everything here is wired to a real backend endpoint or a real browser API.
   No decorative dead buttons.
   Backend surface used:
     POST /api/chat     { message } -> { reply, temperatureVariable, apiTemperature, contextItemsUsed }
     GET  /api/context  -> { count, items:[{kind, topic, text, ts}] }
     GET  /api/health   -> { ok, model }
   ========================================================================== */

"use strict";

// ── tiny DOM helpers ────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── elements ────────────────────────────────────────────────────────────────
const app = $("#app");
const messagesEl = $("#messages");
const welcomeEl = $("#welcome");
const conversationEl = $("#conversation");
const convListEl = $("#convList");
const convTitleEl = $("#convTitle");
const formEl = $("#composer");
const inputEl = $("#input");
const sendEl = $("#send");
const voiceBtn = $("#voiceBtn");
const feedEl = $("#feed");
const feedCountEl = $("#feedCount");

// ── persistent state ────────────────────────────────────────────────────────
const LS_CONV = "rac.conversations";
const LS_CUR = "rac.current";
const LS_THEME = "rac.theme";
const LS_MIND = "rac.mind";

/** @typedef {{role:'user'|'assistant'|'system', content:string, meta?:object}} Msg */
/** @typedef {{id:string, title:string, createdAt:number, updatedAt:number, messages:Msg[]}} Conv */

/** @type {Conv[]} */
let conversations = load(LS_CONV, []);
let currentId = localStorage.getItem(LS_CUR) || null;
let inFlight = null; // AbortController for the active request

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function persist() {
  localStorage.setItem(LS_CONV, JSON.stringify(conversations));
  if (currentId) localStorage.setItem(LS_CUR, currentId);
}
const current = () => conversations.find((c) => c.id === currentId) || null;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ── markdown rendering (marked + DOMPurify + highlight.js + KaTeX) ───────────
if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}
function renderMarkdown(text) {
  const raw = window.marked ? marked.parse(text) : escapeHtml(text);
  return window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
}

const COPY_SVG = '<svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

// Enhance code blocks per spec: language badge, copy, wrap toggle, collapse.
function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement?.classList.contains("code-block")) return;
    if (window.hljs) {
      try { hljs.highlightElement(code); } catch { /* unknown lang */ }
    }
    const langMatch = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = langMatch ? langMatch.replace("language-", "") : "text";

    const block = el("div", "code-block");
    const head = el("div", "code-block__head");
    head.appendChild(el("span", "code-block__lang", escapeHtml(lang)));
    const actions = el("div", "code-block__actions");

    const wrapBtn = el("button", "code-block__btn", "Wrap");
    wrapBtn.type = "button";
    wrapBtn.onclick = () => block.classList.toggle("wrap");

    const collapseBtn = el("button", "code-block__btn", "Collapse");
    collapseBtn.type = "button";
    collapseBtn.onclick = () => {
      block.classList.toggle("collapsed");
      collapseBtn.textContent = block.classList.contains("collapsed") ? "Expand" : "Collapse";
    };

    const copyBtn = el("button", "code-block__btn", COPY_SVG + "Copy");
    copyBtn.type = "button";
    copyBtn.onclick = () => copy(code.textContent, copyBtn, "Copy");

    actions.append(wrapBtn, collapseBtn, copyBtn);
    head.appendChild(actions);

    pre.replaceWith(block);
    block.append(head, pre);
  });
}

function renderRichInto(node, text) {
  node.innerHTML = renderMarkdown(text);
  enhanceCodeBlocks(node);
  if (window.renderMathInElement) {
    try {
      renderMathInElement(node, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch { /* ignore */ }
  }
}

// ── toasts ──────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = el("div", "toast", escapeHtml(msg));
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 200); }, 1800);
}
async function copy(text, btn, restore) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.innerHTML = "Copied"; setTimeout(() => (btn.innerHTML = (restore === "Copy" ? COPY_SVG : "") + restore), 1200); }
    else toast("Copied to clipboard");
  } catch { toast("Copy failed"); }
}

// ── temperature → colour (project signature) ────────────────────────────────
function tempColor(t) {
  const hue = 220 - (t / 100) * 220; // 220 = cool blue … 0 = hot red
  return `hsl(${hue}, 85%, 52%)`;
}

// ── conversation management ─────────────────────────────────────────────────
function newConversation(activate = true) {
  const c = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  conversations.unshift(c);
  if (activate) { currentId = c.id; persist(); renderAll(); inputEl.focus(); }
  return c;
}

function ensureConversation() {
  let c = current();
  if (!c) c = newConversation(false), (currentId = c.id);
  return c;
}

function deleteConversation(id) {
  conversations = conversations.filter((c) => c.id !== id);
  if (currentId === id) currentId = conversations[0]?.id || null;
  persist();
  renderAll();
}

function renameConversation(id, title) {
  const c = conversations.find((x) => x.id === id);
  if (!c) return;
  c.title = title.trim() || "Untitled";
  c.updatedAt = Date.now();
  persist();
  renderSidebar();
  if (id === currentId) convTitleEl.textContent = c.title;
}

function titleFrom(text) {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t || "New chat";
}

// ── relative time ───────────────────────────────────────────────────────────
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(ts).toLocaleDateString();
}

// ── rendering: sidebar ──────────────────────────────────────────────────────
function renderSidebar(filter = "") {
  const q = filter.trim().toLowerCase();
  convListEl.innerHTML = "";
  const list = conversations
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (!list.length) {
    convListEl.appendChild(el("div", "mind__empty", q ? "No matching chats" : "No conversations yet"));
    return;
  }

  for (const c of list) {
    const item = el("div", "conv-item");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    if (c.id === currentId) item.setAttribute("aria-current", "true");

    const body = el("div", "conv-item__body");
    body.appendChild(el("div", "conv-item__title", escapeHtml(c.title)));
    body.appendChild(el("div", "conv-item__time", relTime(c.updatedAt)));
    item.appendChild(body);

    const menu = el("button", "icon-btn conv-item__menu", '<svg viewBox="0 0 24 24" class="ic"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>');
    menu.title = "Options";
    menu.onclick = (e) => { e.stopPropagation(); openCtxMenu(e, c.id); };
    item.appendChild(menu);

    const open = () => { currentId = c.id; persist(); renderAll(); closeDrawer(); };
    item.onclick = open;
    item.onkeydown = (e) => { if (e.key === "Enter") open(); };
    convListEl.appendChild(item);
  }
}

// ── rendering: conversation ─────────────────────────────────────────────────
function renderConversation() {
  const c = current();
  messagesEl.innerHTML = "";

  if (!c || c.messages.length === 0) {
    welcomeEl.hidden = false;
    messagesEl.hidden = true;
    convTitleEl.textContent = c ? c.title : "New chat";
    return;
  }

  welcomeEl.hidden = true;
  messagesEl.hidden = false;
  convTitleEl.textContent = c.title;
  c.messages.forEach((m) => messagesEl.appendChild(buildMessage(m)));
  scrollToBottom();
}

function renderAll() {
  renderSidebar($("#sidebarSearch").value);
  renderConversation();
}

function scrollToBottom() {
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

// ── message DOM ─────────────────────────────────────────────────────────────
function buildMessage(m) {
  const wrap = el("div", `msg msg--${m.role}`);
  const bubble = el("div", "bubble");

  if (m.role === "assistant") renderRichInto(bubble, m.content);
  else bubble.textContent = m.content;
  wrap.appendChild(bubble);

  // project signature: temperature + context reveal on assistant messages
  if (m.role === "assistant" && m.meta) {
    const meta = el("div", "meta");
    const chip = el("span", "tempchip", `🌡 temp ${Number(m.meta.temperatureVariable).toFixed(2)}/100`);
    chip.style.background = tempColor(m.meta.temperatureVariable);
    meta.appendChild(chip);
    meta.appendChild(el("span", null, `api ${Number(m.meta.apiTemperature).toFixed(4)} · ${m.meta.contextItemsUsed} random fragments in context`));
    wrap.appendChild(meta);
  }

  wrap.appendChild(buildActions(m));
  return wrap;
}

function iconBtn(title, svg, onClick) {
  const b = el("button", "icon-btn", svg);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onClick;
  return b;
}

function buildActions(m) {
  const row = el("div", "msg__actions");
  // Copy — works for both roles
  row.appendChild(iconBtn("Copy", '<svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>', () => copy(m.content)));

  if (m.role === "assistant") {
    // Regenerate — re-asks the previous user prompt (real)
    row.appendChild(iconBtn("Regenerate", '<svg viewBox="0 0 24 24" class="ic"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></svg>', () => regenerate(m)));
    // Speak — Web Speech API (real)
    if ("speechSynthesis" in window) {
      row.appendChild(iconBtn("Speak", '<svg viewBox="0 0 24 24" class="ic"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>', () => speak(m.content)));
    }
  } else {
    // Edit — load prompt back into composer (real)
    row.appendChild(iconBtn("Edit", '<svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>', () => { inputEl.value = m.content; autoresize(); inputEl.focus(); }));
    // Delete — remove this user turn (+ following assistant) (real)
    row.appendChild(iconBtn("Delete", '<svg viewBox="0 0 24 24" class="ic"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>', () => deleteTurn(m)));
  }
  return row;
}

function speak(text) {
  const synth = window.speechSynthesis;
  if (synth.speaking) { synth.cancel(); return; }
  const u = new SpeechSynthesisUtterance(text);
  synth.speak(u);
}

function deleteTurn(userMsg) {
  const c = current();
  if (!c) return;
  const i = c.messages.indexOf(userMsg);
  if (i < 0) return;
  const removeCount = c.messages[i + 1]?.role === "assistant" ? 2 : 1;
  c.messages.splice(i, removeCount);
  c.updatedAt = Date.now();
  persist();
  renderConversation();
}

async function regenerate(assistantMsg) {
  const c = current();
  if (!c || inFlight) return;
  const i = c.messages.indexOf(assistantMsg);
  const prev = c.messages[i - 1];
  if (!prev || prev.role !== "user") return;
  c.messages.splice(i, 1); // drop old answer
  persist();
  renderConversation();
  await ask(prev.content, false);
}

// ── sending ─────────────────────────────────────────────────────────────────
function setGenerating(on) {
  inputEl.disabled = on;
  if (on) {
    sendEl.classList.add("is-generating");
    sendEl.title = "Stop generating";
    sendEl.innerHTML = '<svg viewBox="0 0 24 24" class="ic ic--fill"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  } else {
    sendEl.classList.remove("is-generating");
    sendEl.title = "Send";
    sendEl.innerHTML = '<svg viewBox="0 0 24 24" class="ic ic--fill"><path d="M4 12l16-8-6 8 6 8z"/></svg>';
    inputEl.disabled = false;
  }
}

function showTyping() {
  const wrap = el("div", "msg msg--assistant");
  wrap.id = "typing";
  wrap.appendChild(el("div", "bubble", '<div class="typing-dots"><span></span><span></span><span></span></div>'));
  messagesEl.appendChild(wrap);
  scrollToBottom();
}
const hideTyping = () => $("#typing")?.remove();

async function ask(text, pushUser = true) {
  const c = ensureConversation();

  if (pushUser) {
    if (c.messages.length === 0) c.title = titleFrom(text);
    c.messages.push({ role: "user", content: text });
    c.updatedAt = Date.now();
    persist();
    renderAll();
  }

  welcomeEl.hidden = true;
  messagesEl.hidden = false;
  setGenerating(true);
  showTyping();

  inFlight = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: inFlight.signal,
    });
    const data = await res.json();
    hideTyping();
    if (!res.ok) throw new Error(data.error || "request failed");

    c.messages.push({
      role: "assistant",
      content: data.reply,
      meta: {
        temperatureVariable: data.temperatureVariable,
        apiTemperature: data.apiTemperature,
        contextItemsUsed: data.contextItemsUsed,
      },
    });
    c.updatedAt = Date.now();
    persist();
    renderConversation();
    renderSidebar($("#sidebarSearch").value);
  } catch (err) {
    hideTyping();
    if (err.name === "AbortError") {
      c.messages.push({ role: "system", content: "Generation stopped." });
    } else {
      c.messages.push({ role: "system", content: "⚠ " + err.message });
    }
    persist();
    renderConversation();
  } finally {
    inFlight = null;
    setGenerating(false);
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (inFlight) { inFlight.abort(); return; } // send button doubles as stop
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  autoresize();
  ask(text);
});

// ── composer behaviour: auto-resize + Enter/Shift+Enter ─────────────────────
function autoresize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 288) + "px";
}
inputEl.addEventListener("input", autoresize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

// ── voice input (Web Speech API) ────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  voiceBtn.hidden = false;
  const recog = new SR();
  recog.interimResults = true;
  recog.lang = navigator.language || "en-US";
  let base = "";
  let recording = false;

  recog.onresult = (e) => {
    let txt = "";
    for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
    inputEl.value = (base + " " + txt).trim();
    autoresize();
  };
  recog.onend = () => { recording = false; voiceBtn.classList.remove("voiceBtn--recording"); };
  recog.onerror = () => { recording = false; voiceBtn.classList.remove("voiceBtn--recording"); };

  voiceBtn.onclick = () => {
    if (recording) { recog.stop(); return; }
    base = inputEl.value;
    recording = true;
    voiceBtn.classList.add("voiceBtn--recording");
    try { recog.start(); } catch { /* already started */ }
  };
}

// ── context menu (rename / delete) ──────────────────────────────────────────
const ctxMenu = $("#ctxMenu");
let ctxTarget = null;
function openCtxMenu(e, id) {
  ctxTarget = id;
  ctxMenu.hidden = false;
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 100);
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
}
function closeCtxMenu() { ctxMenu.hidden = true; ctxTarget = null; }
ctxMenu.addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (!act || !ctxTarget) return;
  const id = ctxTarget;
  if (act === "rename") {
    const c = conversations.find((x) => x.id === id);
    const name = prompt("Rename conversation", c?.title || "");
    if (name != null) renameConversation(id, name);
  } else if (act === "delete") {
    if (confirm("Delete this conversation?")) deleteConversation(id);
  }
  closeCtxMenu();
});
document.addEventListener("click", (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeCtxMenu();
});

// rename via header title
convTitleEl.addEventListener("click", () => {
  const c = current();
  if (!c) return;
  const name = prompt("Rename conversation", c.title);
  if (name != null) renameConversation(c.id, name);
});

// ── theme (light / dark / system) ───────────────────────────────────────────
const THEMES = ["system", "light", "dark"];
const THEME_ICONS = {
  system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(LS_THEME, t);
  $("#themeLabel").textContent = t[0].toUpperCase() + t.slice(1);
  $("#themeIcon").innerHTML = THEME_ICONS[t];
  // switch highlight.js stylesheet to match
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#hljs-light").disabled = dark;
  $("#hljs-dark").disabled = !dark;
  // reflect in settings segmented control
  $("#themeSeg")?.querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.themeVal === t))
  );
}
function cycleTheme() {
  const cur = localStorage.getItem(LS_THEME) || "system";
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
}
$("#themeBtn").onclick = cycleTheme;
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((localStorage.getItem(LS_THEME) || "system") === "system") applyTheme("system");
});

// ── settings dialog ─────────────────────────────────────────────────────────
const settingsDialog = $("#settingsDialog");
$("#settingsBtn").onclick = () => settingsDialog.showModal();
$("#settingsClose").onclick = () => settingsDialog.close();
$("#themeSeg").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.themeVal;
  if (v) applyTheme(v);
});
$("#clearAllBtn").onclick = () => {
  if (!confirm("Delete ALL conversations? This cannot be undone.")) return;
  conversations = [];
  currentId = null;
  localStorage.removeItem(LS_CUR);
  persist();
  renderAll();
  settingsDialog.close();
  toast("All conversations deleted");
};

// ── search dialog (Ctrl/Cmd+K) ──────────────────────────────────────────────
const searchDialog = $("#searchDialog");
const globalSearch = $("#globalSearch");
const searchResults = $("#searchResults");

function openSearch() {
  searchDialog.showModal();
  globalSearch.value = "";
  runSearch("");
  globalSearch.focus();
}
function runSearch(q) {
  q = q.trim().toLowerCase();
  searchResults.innerHTML = "";
  const hits = conversations
    .map((c) => {
      const inTitle = c.title.toLowerCase().includes(q);
      const msg = c.messages.find((m) => m.content.toLowerCase().includes(q));
      if (q && !inTitle && !msg) return null;
      return { c, snippet: msg?.content || c.messages[0]?.content || "" };
    })
    .filter(Boolean)
    .slice(0, 30);

  if (!hits.length) {
    searchResults.appendChild(el("div", "search-empty", q ? "No results" : "Type to search your conversations"));
    return;
  }
  for (const { c, snippet } of hits) {
    const r = el("button", "search-result");
    const sn = snippet.length > 120 ? snippet.slice(0, 120) + "…" : snippet;
    r.innerHTML = `<div class="search-result__title">${highlight(c.title, q)}</div><div class="search-result__snippet">${highlight(sn, q)}</div>`;
    r.onclick = () => { currentId = c.id; persist(); renderAll(); searchDialog.close(); };
    searchResults.appendChild(r);
  }
}
function highlight(text, q) {
  const e = escapeHtml(text);
  if (!q) return e;
  const i = e.toLowerCase().indexOf(q);
  if (i < 0) return e;
  return e.slice(0, i) + "<mark>" + e.slice(i, i + q.length) + "</mark>" + e.slice(i + q.length);
}
globalSearch?.addEventListener("input", () => runSearch(globalSearch.value));
$("#searchBtn").onclick = openSearch;

// ── sidebar search (inline filter) ──────────────────────────────────────────
$("#sidebarSearch").addEventListener("input", (e) => renderSidebar(e.target.value));

// ── sidebar collapse / mobile drawer / mind panel ───────────────────────────
$("#collapseBtn").onclick = () => {
  const collapsed = app.getAttribute("data-collapsed") === "true";
  app.setAttribute("data-collapsed", String(!collapsed));
};
$("#menuBtn").onclick = () => app.setAttribute("data-drawer", "open");
$("#sidebarScrim").onclick = closeDrawer;
function closeDrawer() { app.removeAttribute("data-drawer"); }

const mindBtn = $("#mindBtn");
function setMind(open) {
  if (open) app.setAttribute("data-mind", "open");
  else app.removeAttribute("data-mind");
  localStorage.setItem(LS_MIND, open ? "open" : "closed");
}
mindBtn.onclick = () => setMind(app.getAttribute("data-mind") !== "open");

// ── new chat ────────────────────────────────────────────────────────────────
$("#newChatBtn").onclick = () => { newConversation(); closeDrawer(); };

// ── keyboard shortcuts (spec §Keyboard Shortcuts) ───────────────────────────
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); }
  else if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newConversation(); }
  else if (e.key === "Escape") { closeCtxMenu(); }
  else if (e.key === "ArrowUp" && document.activeElement === inputEl && inputEl.value === "") {
    // Edit last prompt
    const c = current();
    const lastUser = [...(c?.messages || [])].reverse().find((m) => m.role === "user");
    if (lastUser) { e.preventDefault(); inputEl.value = lastUser.content; autoresize(); }
  }
});

// ── Random Mind generator pause/resume (POST /api/generator) ────────────────
const genToggle = $("#genToggle");
let genRunning = true;
const PAUSE_SVG = '<svg viewBox="0 0 24 24" class="ic"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" class="ic ic--fill"><path d="M7 4l13 8-13 8z"/></svg>';
function updateGenBtn() {
  genToggle.innerHTML = genRunning ? PAUSE_SVG : PLAY_SVG;
  genToggle.title = genRunning ? "Pause generating" : "Resume generating";
  genToggle.setAttribute("aria-label", genToggle.title);
}
genToggle.onclick = async () => {
  genRunning = !genRunning;
  updateGenBtn();
  toast(genRunning ? "Random Mind resumed" : "Random Mind paused");
  try {
    await fetch("/api/generator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ running: genRunning }),
    });
  } catch { /* will re-sync on next feed poll */ }
};

// ── Random Mind live feed (GET /api/context) ────────────────────────────────
async function refreshFeed() {
  try {
    const res = await fetch("/api/context");
    const data = await res.json();
    if (typeof data.running === "boolean" && data.running !== genRunning) {
      genRunning = data.running;
      updateGenBtn();
    }
    feedCountEl.textContent = genRunning
      ? `${data.count} dream${data.count === 1 ? "" : "s"}`
      : "paused";
    feedEl.innerHTML = "";
    if (!data.items.length) {
      feedEl.appendChild(el("div", "mind__empty", "The Random Mind is warming up…"));
      return;
    }
    for (const item of data.items) {
      const card = el("div", "card");
      card.appendChild(el("div", "card__kind", escapeHtml(`${item.kind} · ${item.topic}`)));
      card.appendChild(el("div", "card__text", escapeHtml(item.text)));
      feedEl.appendChild(card);
    }
  } catch { /* server not ready */ }
}

// ── active model badge (GET /api/health) ────────────────────────────────────
async function loadModel() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const name = data.model || "model";
    $("#modelBadge").textContent = name;
    $("#modelBadge2").textContent = name;
  } catch {
    $("#modelBadge").textContent = "offline";
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
function boot() {
  applyTheme(localStorage.getItem(LS_THEME) || "dark");
  setMind((localStorage.getItem(LS_MIND) || "open") === "open");
  if (!conversations.length) newConversation(false);
  if (!current()) currentId = conversations[0]?.id || null;
  renderAll();
  updateGenBtn();
  loadModel();
  refreshFeed();
  setInterval(refreshFeed, 5000);
}
boot();
