# Steiner

An AI brainstorming desktop app. The window is split in two: on the left, an
embedded WKWebView loads `claude.ai`; on the right, an infinite canvas (built
on [tauri-drawing](https://github.com/laffan/tauri-drawing)) acts as a
workspace for snippets you pin from the conversation. Selections flow both
ways — pin text out of Claude into the canvas, or send canvas notes back into
Claude as the next prompt.

Steiner is a Tauri 2.0 app (macOS first; iOS-ready scaffolding is preserved
but not validated).

For architecture, IPC, and extension points, see
[README-TECHNICAL.md](./README-TECHNICAL.md).

## How it works

**Pin from Claude → canvas**

1. Log into your existing Claude account inside the embedded webview. Cookies
   persist across launches, and the last `claude.ai` URL is restored on
   relaunch.
2. Highlight text in the conversation.
3. Press **⌘⇧P** (Cmd+Shift+P). The selection — plus its source URL,
   timestamp, and the first ~200 characters of the surrounding block as
   context — attaches to the cursor. Markdown formatting is preserved.
4. Click anywhere on the canvas to drop it as a new text node. Metadata is
   stored alongside the node but not displayed.
5. Press **Escape** to cancel a pending pin.

**Send from canvas → Claude**

1. Select one or more text nodes on the canvas.
2. Click the paper-plane icon ("Send to Claude") in the floating selection
   toolbar.
3. The text is injected into the Claude prompt input, prefixed with
   `Tell me more about ...`. Multiple selections are concatenated under a
   single prompt with snippet separators.
4. If injection fails (e.g. claude.ai changes its DOM), the text falls back
   to the clipboard and a toast tells you to paste manually.

**Flowchart connections**

Drop a text node onto another text node to draw a parent → child arrow
between them. Dragging a parent moves its children along with it. Hover an
arrow to delete it. Connections persist with the canvas.

**Persistence**

Snippets and canvas state are stored as JSON in the app's data directory:

- `<appData>/snippets.json` — append-only log of every pinned snippet
- `<appData>/canvas.json` — `{ shapes, snippetMeta, flowchart }`, restored
  on startup
- `<appData>/session.json` — last visited `claude.ai` URL

On macOS the data directory resolves to
`~/Library/Application Support/com.steiner.app/`.

## What it does *not* do

- No DOM scraping of Claude's message structure. Capture is selection-based.
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
npm run setup:assets   # one-time: fetch fonts + app icons (see below)
npm run tauri:dev      # dev with hot reload
npm run tauri:build    # production .app + .dmg
```

For pure web canvas development without the Claude pane:

```bash
npm run dev            # http://localhost:5173 — canvas only, no IPC
```

### Asset fetching

The repo intentionally does **not** check in binary assets — the woff2 fonts
under `public/fonts/` and the app icons under `src-tauri/icons/`. They are
unchanged from the upstream
[tauri-drawing](https://github.com/laffan/tauri-drawing) project.
`npm run setup:assets` runs `scripts/fetch-assets.mjs`, which downloads them
from `raw.githubusercontent.com/laffan/tauri-drawing/main/...`. The script
is idempotent — re-running it skips files already on disk.

To use your own icon, run `npx tauri icon path/to/source.png` after the
asset fetch (it overwrites the icon set).

## Keyboard shortcuts

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| **⌘⇧P**        | Pin current claude.ai selection (global)                |
| **Escape**     | Cancel pending pin                                      |
| (canvas)       | All shortcuts inherited from tauri-drawing              |

## Inherited canvas features

The right pane is the full tauri-drawing canvas. See its
[README](https://github.com/laffan/tauri-drawing) for pan/zoom, brainstorm
mode, drag areas, themes, undo/redo, the shelf, and the pocket. Steiner adds
the Claude pane, the pin/send flows, the flowchart layer, and auto-persistence
of canvas state to `<appData>/canvas.json`.
