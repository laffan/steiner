# Steiner

An AI brainstorming desktop app. The window is split in two: on the left, an
embedded WKWebView loads `claude.ai`; on the right, an infinite canvas (built
on [tauri-drawing](https://github.com/laffan/tauri-drawing)) acts as a
workspace for snippets you pin from the conversation. Selections flow both
ways — you pin text out of Claude into the canvas, and you can send canvas
notes back into Claude as the next prompt.

Steiner is a Tauri 2.0 app (macOS first; iOS-ready scaffolding is preserved
but not validated).

## How it works

**Pin from Claude → canvas**

1. Log into your existing Claude account inside the embedded webview. Cookies
   persist across launches.
2. Highlight text in the conversation.
3. Press **⌘⇧P** (Cmd+Shift+P). The selection — plus its source URL,
   timestamp, and the first ~200 characters of the surrounding block as
   context — attaches to the cursor.
4. Click anywhere on the canvas to drop it as a new text node. Metadata is
   stored alongside the node but is not displayed.
5. Press **Escape** to cancel a pending pin.

**Send from canvas → Claude**

1. Select one or more text nodes on the canvas.
2. Click the paper-plane icon ("Send to Claude") in the floating selection
   toolbar.
3. The text is injected into the Claude prompt input, prefixed with
   `Tell me more about ...`. Multiple selections are concatenated under a
   single prompt with snippet separators.
4. If injection fails (e.g. the input element can't be located on a future
   claude.ai redesign), the text falls back to the clipboard and a toast
   tells you to paste manually.

**Persistence**

Snippets and canvas state are stored as JSON in the app's data directory:

- `<appData>/snippets.json` — append-only log of every pinned snippet
- `<appData>/canvas.json` — `{ shapes, snippetMeta }`, restored on startup

On macOS the data directory resolves to
`~/Library/Application Support/com.steiner.app/`.

## What it does *not* do

- No DOM scraping of Claude's message structure. Capture is selection-based
  only.
- No use of the Anthropic API. The conversation lives entirely inside the
  embedded webview, signed in with your normal Claude account.
- No automatic capture. Every pin is user-initiated via ⌘⇧P.
- No custom auth — WKWebView handles login + cookies natively.

## Build & run

Prerequisites:

- macOS with Xcode command-line tools
- Rust 1.77+ (`rustup`)
- Node 18+ and npm
- Tauri prerequisites (see <https://v2.tauri.app/start/prerequisites/>)

```bash
npm install
npm run setup:assets   # one-time: fetch fonts + app icons (binary assets,
                       # see "Asset fetching" below)
npm run tauri:dev      # dev with hot reload (auto-launches the app)
npm run tauri:build    # production .app + .dmg
```

### Asset fetching

The repo intentionally does **not** check in binary assets — the woff2 fonts
under `public/fonts/` and the app icons under `src-tauri/icons/`. They are
unchanged from the upstream
[tauri-drawing](https://github.com/laffan/tauri-drawing) project.
`npm run setup:assets` runs `scripts/fetch-assets.mjs`, which downloads them
from `raw.githubusercontent.com/laffan/tauri-drawing/main/...` into the
expected locations. The script is idempotent — re-running it skips files
already on disk.

If you want to use your own icon, run `npx tauri icon path/to/source.png`
after the asset fetch (it overwrites the icon set).

For pure web canvas development without the Claude pane:

```bash
npm run dev            # http://localhost:5173 — canvas only, no IPC
```

## Architecture

```
┌─────────────── main window ────────────────┐
│                                            │
│  ┌── webview "claude" ──┐ ┌── webview ───┐ │
│  │                      │ │   "canvas"   │ │
│  │  https://claude.ai/  │ │              │ │
│  │  (initialization     │ │  index.html  │ │
│  │   script injects     │ │  (Vite/TS    │ │
│  │   __steinerCapture-  │ │   canvas)    │ │
│  │   Pin and __steiner- │ │              │ │
│  │   SendToClaude)      │ │              │ │
│  └──────────────────────┘ └──────────────┘ │
│                                            │
└────────────────────────────────────────────┘
                ▲              ▲
                │   Tauri IPC  │
                ▼              ▼
        ┌────────── Rust backend ─────────┐
        │  - global shortcut ⌘⇧P          │
        │  - pin_snippet  (claude→canvas) │
        │  - send_to_claude (canvas→eval) │
        │  - load/save_canvas_state       │
        │  - load_snippets                │
        └─────────────────────────────────┘
```

Key files:

| File                                            | Purpose                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `src-tauri/src/lib.rs`                          | Builds the parent window + two child webviews; commands; shortcut    |
| `src-tauri/capabilities/default.json`           | Capabilities for the local canvas webview                            |
| `src-tauri/capabilities/claude.json`            | Capabilities for the remote claude.ai webview (only `pin_snippet`)   |
| `src/claude-content-script.js`                  | Injected into claude.ai on every page load — capture + injection     |
| `src/steiner-bridge.ts`                         | Canvas-side bridge: pin placement, send-to-Claude, persistence       |
| `src/main.ts`                                   | Wires `NotesCanvas` to `SteinerBridge`                               |
| `src/notes-canvas.ts`, `src/state.ts`, `src/ui` | Inherited tauri-drawing canvas (unchanged)                           |

### Why two webviews?

`claude.ai` sets `X-Frame-Options`/`CSP` headers that block iframing.
Tauri 2's multi-webview window API lets us host two independent WKWebViews
side-by-side under one window, with the Rust backend as a bridge between
them. The pin shortcut is registered as a system-wide global shortcut so it
fires regardless of which webview has focus; the content script also listens
locally as a backup.

## iOS

The Tauri config retains the iOS bundle target and the project structure
should permit `npm run tauri:ios-init && npm run tauri:ios-dev`. iOS-specific
concerns intentionally **not** addressed in this iteration:

- WKWebView script-injection timing on iOS
- Global keyboard shortcuts (iOS does not have global shortcuts in the
  desktop sense — the in-webview ⌘⇧P fallback in
  `claude-content-script.js` would still fire on iPad keyboards)
- Touch-friendly placement UX

## Inherited canvas features

The right pane is the full tauri-drawing canvas. See its
[README](https://github.com/laffan/tauri-drawing) for details: pan/zoom,
brainstorm mode, drag areas, themes, undo/redo, the shelf, the pocket, etc.
Steiner adds:

- A pin-from-Claude flow with metadata (URL/timestamp/context)
- A send-to-Claude action in the selection toolbar
- Auto-persistence of canvas state to `<appData>/canvas.json`

## Keyboard shortcuts

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| **⌘⇧P**        | Pin current claude.ai selection (global)                |
| **Escape**     | Cancel pending pin                                      |
| (canvas)       | All shortcuts inherited from tauri-drawing              |
