# Requirements

Dependencies and the UI spec → implementation mapping for **Random ahh Chat**.
The UI follows [`ui.txt`](ui.txt) ("AI Assistant Web Application — UI Design Specification"),
implemented only for features the backend actually supports (no decorative dead buttons).

---

## Runtime

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 (uses global `fetch`, ESM) |
| A reachable OpenAI-compatible AWS Bedrock endpoint | per `.env` |

## Backend dependencies (npm — in `package.json`)

| Package | Purpose |
|---|---|
| `express` | static file server + JSON API (`/api/chat`, `/api/context`, `/api/health`) |
| `openai` | client pointed at the Bedrock OpenAI-compatible gateway |
| `aws4` | SigV4-signs each request when using AWS access-key/secret (see Auth below) |
| `dotenv` | loads `.env` |

Install:

```bash
npm install
```

## Frontend dependencies (loaded via CDN in `public/index.html`)

The frontend is static (no build step), so libraries are pulled from a CDN at runtime.
The app already requires network access (to reach the LLM), so this adds no new constraint.

| Library | Version | Why (spec section) |
|---|---|---|
| **Inter** + **JetBrains Mono** (Google Fonts) | latest | Typography — spec wants Inter; mono for code |
| **marked** | 12.0.2 | Markdown rendering in assistant messages |
| **DOMPurify** | 3.0.11 | Sanitizes model-generated HTML (XSS-safe) |
| **highlight.js** | 11.9.0 | Code syntax highlighting (light + dark themes) |
| **KaTeX** (+ auto-render) | 0.16.9 | Math rendering (`$…$`, `$$…$$`) |

> To self-host instead of CDN: `npm i marked dompurify highlight.js katex`, serve them
> from `public/vendor/`, and swap the `<script>`/`<link>` `src`/`href` to local paths.

---

## Environment (`.env`)

See [`.env.example`](.env.example). Required for the server to boot:

- `BEDROCK_BASE_URL`
- **Auth — one of:**
  - `BEDROCK_API_KEY` — a Bedrock **API key (bearer token)**; sent as `Authorization: Bearer …`, or
  - `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`) — standard AWS
    credentials. These are **SigV4** credentials, so the server signs every request with `aws4`
    (`service: "bedrock"`, region from `AWS_REGION`). The gateway rejects raw AWS secrets sent as a
    bearer token (`401 Invalid bearer token`), which is why signing is required.

Optional: `BEDROCK_MODEL`, `PORT`, `GENERATE_EVERY_MS`, `MAX_CONTEXT_ITEMS`, `CONTEXT_ITEMS_FOR_CHAT`.

---

## Spec → implementation mapping

✅ implemented · ⚠️ adapted to the project · ❌ intentionally omitted (would be a non-functional button)

### Layout & structure
- ✅ Sidebar (280px / 72px collapsed) + Header (64px, sticky) + Conversation (max 900px, 32/16px padding, 24px spacing) + sticky Composer
- ✅ Responsive breakpoints: mobile `<640px` (sidebar → drawer), tablet `640–1024px` (Mind panel → overlay), desktop `>1024px`

### Sidebar
- ✅ Logo, **New chat**, conversation history with title + relative timestamp + active state
- ✅ Hover menu → **Rename**, **Delete** (both functional, client-side)
- ❌ **Archive**, **Share** — no backend; omitted
- ✅ Bottom: **Theme switch**, **Settings**
- ❌ User profile / Help — no auth/content behind them; omitted

### Header
- ✅ Left: current conversation title (click to rename)
- ⚠️ Center "model selector" → **read-only model badge** (server model is fixed via `BEDROCK_MODEL`; a selector would do nothing)
- ✅ Right: **Search**, Random-Mind toggle, theme toggle
- ❌ Notifications — nothing produces them; omitted

### Messages
- ✅ User right-aligned (accent bubble); Assistant left-aligned with rich markdown, tables, lists, links, images, code highlighting, math
- ✅ System messages centered/muted (errors, "generation stopped")
- ✅ Actions on hover — Assistant: **Copy**, **Regenerate**, **Speak** (Web Speech API). User: **Edit**, **Delete**, **Copy**
- ❌ Like / Dislike / Share — no-ops with no backend; omitted
- ⚠️ **Project signature kept:** each assistant reply shows its random temperature (0–100), the mapped API temperature, and the number of random context fragments used

### Code block
- ✅ Syntax highlighting, **language badge**, **Copy**, **Wrap toggle**, **Collapse/Expand**

### Composer
- ✅ Multiline auto-expanding textarea (1–12 lines), placeholder "Ask anything…"
- ✅ **Enter** = send, **Shift+Enter** = newline
- ✅ **Voice input** (Web Speech API; button hidden if unsupported)
- ✅ **Send** doubles as **Stop** during generation (AbortController)
- ❌ Upload / Image / Attach document / Web search / Tools — `/api/chat` accepts text only; omitted (so Attachments section is also omitted)

### Welcome screen
- ⚠️ Kept intentionally minimal (logo + "Ask anything…"); the spec's greeting + suggested-prompt cards were removed for a simpler, less cluttered empty state

### Loading state
- ✅ Animated typing indicator + **Cancel generation**
- ❌ Token-by-token streaming — backend returns a single JSON response (not streamed); typing indicator used instead

### Search
- ✅ Global conversation search (Ctrl/Cmd+K), full-text over titles + messages, with match highlighting
- ❌ Date / attachment filters — no attachments and limited metadata; omitted

### Themes
- ✅ Light / Dark / **System** (auto-follows OS, also syncs the code theme)
- ❌ High-contrast — omitted (kept the functional set tight)

### Typography & colors
- ✅ Inter; scale 32/24/16/13/14px. Exact palette: primary `#4F46E5`, surface `#FFF`, bg `#F7F8FA`, text `#1F2937`, success/warning/error, dark theme `#111827`/`#1F2937`/`#F9FAFB`, accent `#6366F1`

### Keyboard shortcuts
- ✅ Ctrl/Cmd+K (search), Ctrl/Cmd+N (new chat), Esc (close), ↑ (edit last prompt when composer empty)

### Accessibility
- ✅ ARIA labels, visible focus states, keyboard-navigable, `prefers-reduced-motion`, `color-scheme` aware

### Motion
- ✅ Hover 150ms, open/close 250ms, page transitions 200ms

### Components present
- ✅ Buttons (primary / ghost / icon / danger), cards, dialogs, context menu, segmented control, toasts, pills, typing indicator

---

## Not implemented (spec "Future Features")

Multiple selectable models, shared conversations, collaborative editing, plugins, AI agents,
canvas mode, voice conversations, video understanding, workspace folders, custom assistants,
API playground, conversation branching, server-side memory, team workspaces — all left as future work.
