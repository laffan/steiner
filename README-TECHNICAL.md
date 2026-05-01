# Steiner — Technical Notes

A guide for developers extending Steiner. For user-facing usage, see
[README.md](./README.md).

## Architecture

```
┌─── desktop (Tauri) ───────────┐    ┌─── web (GitHub Pages) ───┐
│                               │    │                          │
│  Vite/TS frontend (one        │    │  Same Vite/TS frontend   │
│  webview hosts the canvas;    │    │  served as a static      │
│  Rust spawns + positions      │    │  bundle.                 │
│  child webviews for Chat /    │    │                          │
│  Wikipedia inside the         │    │                          │
│  sidebar.)                    │    │                          │
│                ▲              │    │            ▲             │
│                │ Tauri IPC    │    │            │ direct      │
│                ▼              │    │            ▼ fetch       │
│  Rust backend                 │    │  Anthropic REST API      │
│  - sessions/*.json            │    │  localStorage:           │
│  - settings.json              │    │  - steiner.web.settings  │
│  - ask_claude_stream (SSE +   │    │  - steiner.web.sessions* │
│    structured JSON schema)    │    │                          │
│  - dropbox sync               │    │                          │
└───────────────────────────────┘    └──────────────────────────┘
```

The frontend never branches on which build it's in *except* through
`src/runtime.ts`'s `IS_TAURI` boolean. Both the API surface
(`src/api.ts` → `tauriBackend` or `webBackend`) and the event bus
(`src/event-bus.ts`) dispatch internally so UI code stays portable.

## File map

### Frontend

| File                                            | Purpose                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `src/runtime.ts`                                | `IS_TAURI` detection — single source of truth for build target            |
| `src/api.ts`                                    | `ApiBackend` interface + Tauri impl + dispatch                            |
| `src/web-api.ts`                                | Web `ApiBackend` impl: localStorage + direct Anthropic call               |
| `src/event-bus.ts`                              | `listen` / `emit` shim — Tauri pass-through on desktop, in-page on web    |
| `src/main.ts`                                   | App boot: sidebar, sessions, chat panel, canvas wiring                    |
| `src/input-handler.ts`                          | Canvas keyboard + clipboard + drop handlers; `applyAskPayload` helper     |
| `src/clipboard-format.ts`                       | `canvas-clipboard@1` envelope (`encodeSelection`, `tryDecode`, `remap…`)  |
| `src/flowchart.ts`                              | Portable parent→child arrow layer with drop-to-connect                    |
| `src/notes-canvas.ts`, `src/state.ts`, …        | Inherited tauri-drawing canvas engine                                     |
| `src/ui/canvas-drag-touch.ts`                   | Pointer-event drag (touch) → `steiner-touch-drop` CustomEvent             |
| `src/ui/markdown-render.ts`                     | Block / inline / shelf-label markdown → DOM                               |
| `src/ui/sidebar.ts`                             | Sidebar shell + tab strip + browser-webview placeholder hosting           |
| `src/ui/sessions-sidebar.ts`                    | Session list, create, archive, export, settings entry                     |
| `src/ui/settings-modal.ts`                      | General / Prompt / Sync (Tauri-only) tabs                                 |
| `src/ui/sync-tab.ts`                            | Dropbox PKCE flow — desktop only                                          |
| `src/ui/chat-history-panel.ts`                  | Left-edge collapsible panel: History + Terms tabs, transcript drop zone   |
| `src/ui/chat-bubble.ts`                         | Renders user/assistant bubbles (assistants always go through markdown)    |
| `src/ui/shelf-panel.ts`                         | Shelf list with markdown labels and depth-indented rows                   |
| `src/ui/export-modal.ts`                        | Export options + dispatch (Tauri save dialog vs browser download)         |
| `src/notebook-export.ts`                        | Canvas → PNG / JPG / PDF / `.steiner` rendering                           |
| `scripts/fetch-assets.mjs`                      | Idempotent fetcher for woff2 fonts + app icons                            |

### Rust backend (desktop only)

| File                                            | Purpose                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `src-tauri/src/main.rs`                         | Entry point — calls `lib::run`                                            |
| `src-tauri/src/lib.rs`                          | Window setup, all `#[tauri::command]` handlers, browser-webview manager   |
| `src-tauri/src/dropbox.rs`                      | Dropbox OAuth + sync logic                                                |
| `src-tauri/capabilities/default.json`           | Capability set granted to the canvas webview                              |
| `src-tauri/tauri.conf.json`                     | Bundle ID, identifier, build commands                                     |

## Tauri commands (IPC surface)

All commands are defined in `src-tauri/src/lib.rs` and called via the
`api` object in `src/api.ts`. The same TypeScript signatures are
implemented by `src/web-api.ts` against `localStorage` so UI code
doesn't have to branch.

| Command                  | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `get_settings`           | Read full Settings struct (API key, prompt config, last URLs)      |
| `set_api_key`            | Persist Anthropic API key                                          |
| `set_ask_word_limit`     | Persist Ask Claude word-limit                                      |
| `set_ask_model`          | Persist Ask Claude model id                                        |
| `set_ask_prompt_prefix`  | Persist Ask prompt prefix                                          |
| `set_ask_prompt_suffix`  | Persist Ask prompt suffix                                          |
| `is_desktop`             | Returns true on desktop, false on iOS / web                        |
| `show_browser_webview`   | Position + show a child webview (Chat / Wikipedia tab)             |
| `hide_browser_webview`   | Hide a child webview                                               |
| `list_sessions`          | All session metadata, newest first                                 |
| `create_session`         | New session, returns full Session                                  |
| `get_session`            | Read a single session by id                                        |
| `update_session_title`   | Rename a session                                                   |
| `update_session_model`   | Change a session's default model                                   |
| `set_session_archived`   | Archive / unarchive                                                |
| `save_session_canvas`    | Write canvas state (shapes, edges, shape_chats, transcripts)       |
| `delete_session`         | Remove a session file                                              |
| `export_session_markdown`| Render a session as markdown text                                  |
| `write_text_file`        | Sandbox-checked text write (export modal)                          |
| `write_binary_file`      | Sandbox-checked binary write (export modal)                        |
| `send_message`           | Top-level chat message (currently not surfaced in UI)              |
| `ask_claude_stream`      | Streamed Ask Claude — emits `ask-done` / `ask-error` events        |
| `dropbox_status`         | Current link state                                                 |
| `dropbox_exchange_code`  | OAuth code → tokens                                                |
| `dropbox_disconnect`     | Forget tokens                                                      |
| `dropbox_sync_now`       | Push / pull session files                                          |

Events the Rust backend emits to the frontend:

- `ask-done` — `{ request_id, text, segments }` after a successful
  Ask Claude stream.
- `ask-error` — `{ request_id, message }` on failure.
- `session-updated` — fires when sessions change on disk (used to
  refresh the Sessions list).
- `window-resized` — relayout signal so the sidebar re-syncs the
  child webview rect.
- `menu:undo` / `menu:redo` — native Edit menu items routed to the
  canvas.

## Persistence

### Desktop

Under the Tauri-resolved `app_data_dir` — on macOS,
`~/Library/Application Support/com.steiner.app/`.

| Path                           | Format                                                 | Owner             |
| ------------------------------ | ------------------------------------------------------ | ----------------- |
| `settings.json`                | Settings struct                                        | `set_*` commands  |
| `sessions/<id>.json`           | Session — title, model, messages, canvas              | `save_session_*`  |

`canvas` inside each Session is `{ shapes, flow_edges, shape_chats,
transcripts }` and is rewritten in full on save.

### Web

```
localStorage["steiner.web.settings"]        Settings JSON (single object)
localStorage["steiner.web.sessions.index"]  SessionMeta[] (small)
localStorage["steiner.web.session.<id>"]    Session JSON (per-session key)
```

Sessions are keyed individually so the index stays tiny and one
canvas's growth doesn't bloat reads. localStorage caps around 5 MB
per origin; if a future session bumps that, swap `web-api.ts`'s four
load/save helpers for IndexedDB without touching the `ApiBackend`
shape.

## Ask Claude

The backend differs by build but emits the same `ask-done` /
`ask-error` events on the same bus, so `main.ts`'s listener wiring is
identical.

### Desktop (`ask_claude_stream`)

`src-tauri/src/lib.rs` opens a streaming POST to
`/v1/messages` with:

- `stream: true` (SSE)
- `system: ASK_STRUCTURED_SYSTEM` — a system prompt that instructs
  the model to emit a `segments` array conforming to the JSON schema.
- `output_config.format = json_schema` with the schema from
  `ask_response_schema()` — `segments[].kind` ∈ `{text, concept,
  definition, name, book}`.

The SSE stream is parsed as it arrives; `ask-done` carries the joined
text plus `segments`. The Terms tab in the chat-history panel reads
those segments to populate concept / name / book / definition chips.

### Web (`webBackend.askClaudeStream`)

`src/web-api.ts` posts a single (non-streaming) request to
`api.anthropic.com/v1/messages` with the
`anthropic-dangerous-direct-browser-access: true` header. Term
classification rides on a forced tool call:

```
tools: [highlight_terms]              // concepts / names / books arrays
tool_choice: { type: "tool", name: "highlight_terms" }
```

The response carries the answer text in `text` content blocks plus
the structured terms in a `tool_use` block. `buildTermSegments`
flattens the latter into `Segment[]` and `ask-done` ships both. The
key lives in `localStorage["steiner.web.settings"]` — anyone with
access to the user's browser profile can read it, so the web build is
strictly personal-use.

## Markdown rendering

`src/ui/markdown-render.ts` is a small, dependency-free markdown →
DOM renderer. Three entry points:

| Function                          | Use                                                         |
| --------------------------------- | ----------------------------------------------------------- |
| `renderMarkdownToFragment(src)`   | Full block layout — paragraphs, headings, lists, code, etc. |
| `renderInlineMarkdownToFragment`  | Inline tokens only (bold/italic/code/link/highlight).       |
| `renderShelfLabel(src)`           | Heading prefix collapses to `<strong>` (no font-size scale).|

Supported constructs: paragraphs, ATX headings (`#` … `######`),
unordered (`-`/`*`/`+`) and ordered (`\d+.`) lists with loose-list
support, fenced code blocks (` ``` `), and inline `**bold**`,
`*italic*` / `_italic_`, `` `code` ``, `[link](url)`, `==highlight==`.
Single newlines within a paragraph collapse to spaces (CommonMark
behavior); two-blank-line separation creates a new paragraph.

`renderMarkdownToFragment` powers assistant chat bubbles
(`chat-bubble.ts` always feeds content through it — segments live on
the message purely for Terms-tab extraction). `renderShelfLabel`
powers shelf rows (`shelf-panel.ts`).

## Drag from chat panel → canvas

Two paths cover the same payload shape (`AskDropPayload`):

1. **HTML5 drag** — the desktop / mouse path. Term chips and
   highlighted segment spans use `draggable="true"` with a `dragstart`
   handler that sets `text/plain` + `application/x-steiner-ask`.
   Assistant bubbles rely on the standard *select-then-drag-the-
   selection* gesture: the bubble is **not** `draggable="true"`
   (that would steal the first mousedown from text selection); its
   `dragstart` handler requires a selection inside the bubble.
2. **Touch path** (`src/ui/canvas-drag-touch.ts`) — `enableTouchDrag`
   wires `pointerdown`/`move`/`up` for `pointerType === "touch" |
   "pen"`, draws a floating ghost element, and dispatches a
   `steiner-touch-drop` CustomEvent on pointerup over the canvas.
   `input-handler.ts` listens for the event, hit-tests against the
   canvas rect, and routes the payload through `applyAskPayload`.
   Mouse drags are left to the native HTML5 path. iPad Safari
   dispatches HTML5 dragstart for selection drags natively, so the
   bubble doesn't wire `enableTouchDrag` (it would race the native
   path and double-paste).

The shared end of both paths is `applyAskPayload(state, payload,
dropPos)` in `input-handler.ts` — adds the text shape, applies the
chip's highlight color if `kind` is set, and (when `sourceShapeIds`
is provided) connects the new shape as a flowchart child via
`flowchart.tryConnect`.

## Cross-app clipboard

`src/clipboard-format.ts` defines the `canvas-clipboard@1` envelope
shared with [Hush](https://github.com/laffan/hush). See the
user-facing README's "Cross-app clipboard" section for the wire
format and the producer / consumer rules.

The Cmd+C and Cmd+X handlers in `input-handler.ts` write the envelope
via `navigator.clipboard.writeText`. Cmd+V is handled both via the
keydown switch (which calls `navigator.clipboard.readText()` /
`read()` — necessary because browsers don't reliably dispatch a
`paste` event on a non-editable canvas page) **and** the document
`paste` listener (which fires when the user pastes via Edit > Paste
from a native menu). A `lastPasteAt` timestamp dedupes when both fire
within 400 ms.

## Capability split

`src-tauri/capabilities/default.json` grants the canvas webview the
full filesystem / dialog / opener plugin set plus every command.
There's only one capability file in the current build because the
remote-content sub-webviews (Chat, Wikipedia) are managed by Rust
directly — they don't invoke Tauri commands.

## Flowchart layer

`src/flowchart.ts` is a portable add-on with no Steiner-specific
knowledge. Host code wires it up in three places:

1. On drop, call `flow.findDropTarget` then `flow.tryConnect` to snap
   a dropped node onto a target and emit a parent → child arrow.
2. On render (after camera transform), call
   `flow.draw(ctx, shapes)`.
3. On node deletion, call `flow.removeNode(deletedId)`.

The layer is configured with `getBounds` and `isFlowable` callbacks
so it can be reused on other text-object canvases. Edges are
serialized with the canvas state under the `flow_edges` key.

## Build pipeline

- `vite` builds the canvas frontend into `dist/`. Tauri loads
  `dist/index.html` for the canvas webview (`WebviewUrl::App`).
- `cargo` builds `src-tauri/`. No content scripts are bundled into
  the Rust binary — the desktop build no longer injects code into
  remote pages.
- `scripts/fetch-assets.mjs` fetches binary assets that aren't in
  git. It skips files already on disk; safe to re-run.
- Vite's `base` is `'./'` so emitted asset URLs are relative. The
  same `dist/` works under `tauri://localhost/`, on GitHub Pages at
  `/<repo>/`, and on `vite preview`. An absolute base would break
  the Pages deploy; a hardcoded subpath would break Tauri.

## Dual build: Tauri + web

Steiner ships from one source tree to two targets — the desktop
Tauri app and a static web app on GitHub Pages. There's **no
compile-time flag**; the split is runtime, behind a single boolean.

### Where the seam lives

| File                  | Role                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `src/runtime.ts`      | Exports `IS_TAURI` (true iff `window.__TAURI_INTERNALS__` exists). Single source of truth.   |
| `src/api.ts`          | Defines `ApiBackend` interface + Tauri impl; picks `tauriBackend` or `webBackend` at import. |
| `src/web-api.ts`      | Web impl of `ApiBackend` — localStorage persistence + direct Anthropic API for Ask Claude.   |
| `src/event-bus.ts`    | `listen` / `emit` shim. Pass-through to `@tauri-apps/api/event` on desktop; in-page on web.  |

UI code never branches on `IS_TAURI` directly — it talks to `api`
and `listen`, both of which dispatch internally. Two exceptions are
gated explicitly: the Sync tab (Dropbox OAuth needs `steiner://`)
and the export modal's filesystem-write path. Both check `IS_TAURI`
from `runtime.ts`.

### What the web build omits

- **Native child webviews** — the **Chat** (claude.ai) and
  **Wikipedia** sidebar tabs are hidden; the sidebar checks
  `api.isDesktop()` which the web stub returns `false` for.
- **Dropbox sync tab** (`settings-modal.ts` skips mounting it).
- **Filesystem export** (`export-modal.ts` already had a browser
  download fallback; it just routes there now whenever `!IS_TAURI`).

### Adding a new feature without breaking either build

1. Add a method to the `ApiBackend` interface in `src/api.ts`.
2. Implement it in `tauriBackend` (an `invoke` call into Rust).
3. Implement it in `src/web-api.ts`'s `webBackend` — either as a real
   browser-side implementation or with a clear `throw new Error(…)`
   if it's desktop-only (and gate the calling UI on `IS_TAURI`).
4. The compiler enforces both backends stay in sync.

### Deploy

`.github/workflows/pages.yml` runs `npm run setup:assets && npm run
build:web` and publishes `dist/` to GitHub Pages. The workflow wants
**Settings → Pages → Source: GitHub Actions** in the repo before the
first deploy will succeed.

## iOS

The Tauri config retains the iOS bundle target and the project
should permit `npm run tauri:ios-init && npm run tauri:ios-dev`.
iOS-specific concerns intentionally **not** addressed:

- WKWebView script-injection timing
- Touch-friendly placement UX

The touch-drag helper (`canvas-drag-touch.ts`) is wired so iPad in
either build can drag chips and segments from the chat-history panel
onto the canvas.

## Extension pointers

- **New Tauri command**: register in `lib.rs` via
  `#[tauri::command]` and add to the `invoke_handler!` macro in
  `run()`. Then add the matching method to `ApiBackend` in
  `src/api.ts` and implement on both `tauriBackend` and `webBackend`.
- **New event from Rust to canvas**: `app.emit("<name>", payload)` in
  Rust; consume in TS via `listen("<name>", …)` from `event-bus.ts`.
- **Change the canvas persistence schema**: bump the shape in
  `save_session_canvas`'s payload type. The Rust side stores it as
  `serde_json::Value`, so backwards compatibility is the frontend's
  responsibility — guard reads in `main.ts`'s `snapFromBackend` /
  `readShapeChats` / `readTranscripts` helpers.
- **New markdown construct**: extend `splitBlocks` / `renderBlock`
  in `markdown-render.ts`. Inline tokens go in `INLINE_PATTERN` +
  `renderInlineToken`. Keep the parser dependency-free.
- **New chat panel drag source**: wire both an HTML5 `draggable=true`
  + `dragstart` handler **and** `enableTouchDrag(el, getPayload)`
  from `canvas-drag-touch.ts`. The `getPayload` callback returns the
  same shape the HTML5 path stuffs into
  `application/x-steiner-ask`.
