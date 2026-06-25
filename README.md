# Random ahh Chat 🎲

A **double-LLM system** that runs on a single Anthropic API key.

```
┌─────────────────────┐        appends to         ┌──────────────────────┐
│   LLM #1 — The Muse  │  ───────────────────────► │   Shared context     │
│  endlessly generates │   facts / poems / stories │   store (rolling)     │
│  random creative     │                           └──────────┬───────────┘
│  content (temp = 1)  │                                      │ injected as context
└─────────────────────┘                                       ▼
                                          ┌─────────────────────────────────────┐
   user prompt  ───────────────────────►  │  LLM #2 — "Random ahh Chat"          │
                                          │  random temperature 0–100 each turn  │
                                          │  answers the user                    │
                                          └─────────────────────────────────────┘
```

## How the spec maps to the code

| Requirement | Where |
|---|---|
| 1. One LLM keeps generating very random facts / poems / stories | `generateOnce()` loop in [server.js](server.js), runs every 25s at `temperature: 1` |
| 2. Everything it generates is stored as context for the second LLM | `addToContext()` → `contextStore`, fed into LLM #2's system prompt via `recentContextText()` |
| 3. Second LLM gets temperature via a variable randomly generated 0–100 (with decimals) | `randomTempVariable()` returns e.g. `73.42`; mapped to the API's `0–1` range |
| 4. Simple website chatbot "Random ahh Chat" talking to the second LLM | `public/` + `POST /api/chat` |

## A note on temperature (important)

The Anthropic API takes `temperature` in the range **0.0–1.0**, and only **Claude 4.x**
models accept it at all (Opus 4.7/4.8 and Fable 5 reject it with a 400). So:

- The **variable** is generated 0–100 with decimals, exactly as asked (and shown in the UI).
- It is divided by 100 to produce the actual `temperature` sent to the model.
- The model used is **`claude-haiku-4-5`** (supports `temperature`, fast, cheap — ideal for a generator that never stops).

Both the 0–100 variable and the real 0–1 value are returned per message and displayed on each bot bubble.

## Run it

```bash
npm install
cp .env.example .env        # then paste your ANTHROPIC_API_KEY into .env
npm start
```

Open <http://localhost:3000>. The left side is the chatbot; the right side is a
live feed of whatever LLM #1 is dreaming up (which is what the bot is being fed).

## Endpoints

- `POST /api/chat` `{ message }` → `{ reply, temperatureVariable, apiTemperature, contextItemsUsed }`
- `GET /api/context` → `{ count, running, items }` — recent generated fragments (powers the live feed)
- `POST /api/generator` `{ running }` → `{ running }` — pause/resume LLM #1
- `GET /api/health`

## Config (optional, via `.env`)

| Var | Default | Meaning |
|---|---|---|
| `MODEL` | `claude-haiku-4-5` | any temperature-capable Claude 4.x model |
| `PORT` | `3000` | server port |
| `GENERATE_EVERY_MS` | `25000` | how often LLM #1 creates something |
| `MAX_CONTEXT_ITEMS` | `40` | rolling cap on stored fragments |
| `CONTEXT_ITEMS_FOR_CHAT` | `15` | how many recent fragments LLM #2 sees |
