# Steiner — Technical Notes

A guide for developers extending Steiner. For user-facing usage, see
[README.md](./README.md).

## Architecture

```
┌─────────────── main window ────────────────┐
│                                            │
│  ┌── webview "claude" ──┐ ┌── webview ───┐ │
│  │                      │ │   "canvas"   │ │
│  │  https://claude.ai/  │ │              │ │
│  │  (init script        │ │  index.html  │ │
│  │   injects            │ │  (Vite/TS    │ │
│  │   __steinerCapture-  │ │   canvas)    │ │
│  │   Pin and __steiner- │ │              │ │
│  │   SendToClaude)      │ │              │ │
│  └──────────────────────┘ └──────────────┘ │
└────────────────────────────────────────────┘
                ▲              ▲
                │   Tauri IPC  │
                ▼              ▼
        ┌────────── Rust backend ─────────┐
        │  global shortcut ⌘⇧P            │
        │  pin_snippet, send_to_claude    │
        │  set_split_fraction, nudge_split│
        │  load_snippets                  │
        │  load/save_canvas_state         │
        │  set_last_url                   │
        └─────────────────────────────────┘
```

### Why two webviews?

`claude.ai` sets `X-Frame-Options` / `CSP` headers that block iframing.
Tauri 2's multi-webview window API hosts two independent WKWebViews under one
window, with the Rust backend bridging them. The pin shortcut is registered
as a system-wide global shortcut so it fires regardless of which webview has
focus; the content script also listens locally as a backup.

## File map

| File                                            | Purpose                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `src-tauri/src/lib.rs`                          | Builds parent window + two child webviews; commands; ⌘⇧P shortcut    |
| `src-tauri/src/main.rs`                         | Entry point, calls `lib::run`                                        |
| `src-tauri/capabilities/default.json`           | Capabilities for the local canvas webview                            |
| `src-tauri/capabilities/claude.json`            | Capabilities for the remote claude.ai webview (only `pin_snippet`)   |
| `src-tauri/tauri.conf.json`                     | Bundle ID, identifier, build commands                                |
| `src/claude-content-script.js`                  | Injected into claude.ai on every page load — capture + injection     |
| `src/steiner-bridge.ts`                         | Canvas-side bridge: pin placement, send-to-Claude, persistence       |
| `src/main.ts`                                   | Wires `NotesCanvas` to `SteinerBridge`                               |
| `src/flowchart.ts`                              | Portable flowchart layer (parent→child arrows, drop-to-connect)      |
| `src/notes-canvas.ts`, `src/state.ts`, `src/ui` | Inherited tauri-drawing canvas                                       |
| `scripts/fetch-assets.mjs`                      | Idempotent fetcher for woff2 fonts + app icons                       |

## Tauri commands (IPC surface)

All commands are defined in `src-tauri/src/lib.rs` and registered via
`invoke_handler` in `run()`.

| Command              | Caller            | Purpose                                                        |
| -------------------- | ----------------- | -------------------------------------------------------------- |
| `pin_snippet`        | claude webview    | Append snippet to disk + emit `snippet-pinned` to canvas       |
| `send_to_claude`     | canvas webview    | Eval `window.__steinerSendToClaude(...)` in claude webview     |
| `set_split_fraction` | canvas webview    | Set split position (clamped 0.15–0.85), relayouts both views   |
| `nudge_split`        | canvas webview    | Apply pixel delta to split (used by the draggable divider)     |
| `load_snippets`      | canvas webview    | Read `snippets.json`                                           |
| `load_canvas_state`  | canvas webview    | Read `canvas.json` (returns `null` if absent)                  |
| `save_canvas_state`  | canvas webview    | Write `canvas.json` (pretty JSON)                              |
| `set_last_url`       | claude webview nav | Persist last `claude.ai` URL to `session.json`                |

Events:

- `snippet-pinned` (Rust → canvas): payload is `Snippet { id, text, url, timestamp, context }`.

## Capability split

The two webviews have distinct capability sets so that the remote `claude.ai`
context cannot reach into the canvas's filesystem or layout commands.

- `capabilities/claude.json` → only `pin_snippet` and `set_last_url`. The
  remote page cannot read snippets, write canvas state, or move the split.
- `capabilities/default.json` → the canvas-side commands plus FS/dialog
  plugins.

Any new command meant to be callable from the Claude pane must be explicitly
added to `claude.json`.

## Content script lifecycle

`src/claude-content-script.js` is bundled into the Rust binary at compile
time (`include_str!`) and registered with `WebviewBuilder::initialization_script`,
so it runs on every navigation within the Claude webview before page scripts.

It exposes two globals on `window`:

- `__steinerCapturePin()` — reads the current `Selection`, walks up to the
  enclosing block, captures markdown + ~200 chars of context, and invokes
  `pin_snippet`.
- `__steinerSendToClaude({ text, submit })` — locates the prompt input
  (multiple fallbacks), inserts the text, and optionally submits. On failure
  it copies to clipboard and shows a toast.

The Rust backend triggers `__steinerCapturePin` from the global ⌘⇧P
shortcut via `claude.eval(...)`.

## Persistence files

All under the Tauri-resolved `app_data_dir` — on macOS,
`~/Library/Application Support/com.steiner.app/`.

| File             | Format                                            | Owner                |
| ---------------- | ------------------------------------------------- | -------------------- |
| `snippets.json`  | `Snippet[]` — appended on every pin               | `pin_snippet` (Rust) |
| `canvas.json`    | `{ shapes, snippetMeta, flowchart }` (pretty JSON)| `save_canvas_state`  |
| `session.json`   | `{ last_claude_url }`                             | `set_last_url`       |

`canvas.json` is a snapshot, not a log. It is rewritten in full on save.

## Split-pane layout

The two webviews are sized in logical coords by `layout_webviews()` in
`lib.rs`. The current fraction lives in `AppState.split_fraction` (a
`Mutex<f64>`). The window's resize/scale-change events trigger a relayout.
The frontend never sets webview sizes directly — it nudges the fraction via
`nudge_split` (pointer drag on the divider) or `set_split_fraction`.

## Flowchart layer

`src/flowchart.ts` is a portable add-on with no Steiner-specific knowledge.
Host code wires it up in three places:

1. On drop, call `flow.findDropTarget` then `flow.tryConnect` to snap a
   dropped node onto a target and emit a parent → child arrow.
2. On render (after camera transform), call `flow.draw(ctx, shapes)`.
3. On node deletion, call `flow.removeNode(deletedId)`.

The layer is configured with `getBounds` and `isFlowable` callbacks so it
can be reused on other text-object canvases. Edges are serialized with the
canvas state under the `flowchart` key.

## Build pipeline

- `vite` builds the canvas frontend into `dist/`. Tauri loads
  `dist/index.html` for the canvas webview (`WebviewUrl::App`).
- `cargo` builds `src-tauri/`. The content script is `include_str!`'d so
  changes to `claude-content-script.js` require a Rust rebuild.
- `scripts/fetch-assets.mjs` fetches binary assets that aren't in git. It
  skips files already on disk; safe to re-run.
- Vite's `base` is `'./'` so emitted asset URLs are relative. The same
  `dist/` works under `tauri://localhost/`, on GitHub Pages at
  `/<repo>/`, and on `vite preview`. An absolute base would break the
  Pages deploy; a hardcoded subpath would break Tauri.

## Dual build: Tauri + web

Steiner ships from one source tree to two targets — the desktop Tauri app
and a static web app on GitHub Pages. There's **no compile-time flag**;
the split is runtime, behind a single boolean.

### Where the seam lives

| File                  | Role                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `src/runtime.ts`      | Exports `IS_TAURI` (true iff `window.__TAURI_INTERNALS__` exists). Single source of truth.   |
| `src/api.ts`          | Defines `ApiBackend` interface + Tauri impl; picks `tauriBackend` or `webBackend` at import. |
| `src/web-api.ts`      | Web impl of `ApiBackend` — localStorage persistence + direct Anthropic API for Ask Claude.   |
| `src/event-bus.ts`    | `listen` / `emit` shim. Pass-through to `@tauri-apps/api/event` on desktop; in-page on web.  |

UI code never branches on `IS_TAURI` directly — it talks to `api` and
`listen`, both of which dispatch internally. Two exceptions are gated
explicitly: the Sync tab (Dropbox OAuth needs `steiner://`) and the export
modal's filesystem-write path. Both check `IS_TAURI` from `runtime.ts`.

### Web persistence

```
localStorage["steiner.web.settings"]        Settings JSON (single object)
localStorage["steiner.web.sessions.index"]  SessionMeta[] (small)
localStorage["steiner.web.session.<id>"]    Session JSON (per-session key)
```

Sessions are keyed individually so the index stays tiny and a single
canvas's growth doesn't bloat reads. localStorage caps around 5 MB per
origin; if a future session bumps that ceiling, swap `web-api.ts`'s four
load/save helpers for IndexedDB without touching the `ApiBackend` shape.

### Web Ask Claude

`web-api.ts` calls `https://api.anthropic.com/v1/messages` directly with
the user-supplied key (Settings → General). The
`anthropic-dangerous-direct-browser-access: true` header is required
since 2024-08 for browser-origin requests. The user's key is stored in
`localStorage["steiner.web.settings"]` — that's a deliberate trust
trade-off, documented in the user-facing README.

The Tauri version streams via SSE and emits `ask-done`/`ask-error` from
Rust as messages arrive; the web version awaits the full response, then
emits the same events through the in-page `event-bus`. `main.ts`'s
listener wiring is identical for both.

### What the web build omits

- **Claude pane** (`X-Frame-Options` blocks iframing claude.ai).
- **Pin shortcut ⌘⇧P** (no webview to capture from).
- **Chat / Wikipedia sidebar tabs** (native child webviews on desktop;
  the sidebar hides them when `api.isDesktop()` returns false, which the
  web stub does).
- **Dropbox sync tab** (settings-modal.ts skips mounting it on web).
- **Filesystem export** (export-modal.ts already had a browser fallback;
  it just routes there now whenever `!IS_TAURI`).

### Adding a new feature without breaking either build

1. Add a method to the `ApiBackend` interface in `src/api.ts`.
2. Implement it in `tauriBackend` (an `invoke` call into Rust).
3. Implement it in `src/web-api.ts`'s `webBackend` — either as a real
   browser-side implementation or with a clear `throw new Error(…)` if
   it's desktop-only (and gate the calling UI on `IS_TAURI`).
4. The compiler enforces both backends stay in sync.

### Deploy

`.github/workflows/pages.yml` runs `npm run setup:assets && npm run
build:web` and publishes `dist/` to GitHub Pages. The workflow wants
**Settings → Pages → Source: GitHub Actions** in the repo before the
first deploy will succeed.

## iOS

The Tauri config retains the iOS bundle target and the project should permit
`npm run tauri:ios-init && npm run tauri:ios-dev`. iOS-specific concerns
intentionally **not** addressed:

- WKWebView script-injection timing on iOS
- Global keyboard shortcuts (iOS has no global shortcuts; the in-webview
  ⌘⇧P fallback in the content script would still fire on iPad keyboards)
- Touch-friendly placement UX

## Extension pointers

- **New command callable from Claude pane**: register in `lib.rs`'s
  `invoke_handler!`, then add the permission to
  `capabilities/claude.json`.
- **New event from Rust to canvas**: `app.emit_to(CANVAS_LABEL, "<name>", payload)`,
  consume in `steiner-bridge.ts` via `listen("<name>", ...)`.
- **Change persistence schema**: bump the shape in `save_canvas_state`'s
  payload type on the frontend; `canvas.json` is `serde_json::Value` on the
  Rust side, so backwards compatibility is the frontend's responsibility.
- **Customize Claude DOM injection**: edit `claude-content-script.js`. It
  has fallbacks because claude.ai changes layout periodically — keep them.
