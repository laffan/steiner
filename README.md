# Steiner

A research notebook for thinking with Claude. Each **session** is an
infinite canvas of text shapes you can pin, link, and re-arrange. Ask
Claude about any shape and the response lands in a chat-history panel
beside the canvas — drag concepts and names back out to grow the
graph, or copy whole subgraphs (with their flowchart edges) into a
sister app like [Hush](https://github.com/laffan/hush) via a shared
clipboard format.

Steiner builds two ways from one source tree:

- **Desktop** — Tauri 2.0 app (macOS first; iOS scaffolding preserved).
  Sessions and settings live in the app's data directory; the chat
  sidebar can host native sub-webviews for `claude.ai` and Wikipedia.
- **Web** — pure browser bundle hosted on GitHub Pages. Sessions and
  settings live in `localStorage`; **Ask Claude** calls the Anthropic
  API directly with a key the user pastes into Settings.

For architecture, persistence layout, and extension points, see
[README-TECHNICAL.md](./README-TECHNICAL.md).

## How it works

**Sessions**

The Sessions tab in the left sidebar lists every notebook you have
open. Each session owns its own canvas, chat history, and per-shape
ask-Claude transcripts. The most-recent session auto-loads on launch;
"+ New session" mints a fresh canvas.

**Ask Claude on any shape**

Select a text shape on the canvas and click the "Ask Claude" button in
the floating selection toolbar. The seed prompt — `<prefix> <shape
text><suffix>` plus a word-limit clause, all configurable in Settings →
Prompt — is sent to the model picked in Settings → General. The
chat-history panel pops out from the left edge with the new chat
already expanded.

**Chat history panel**

The collapsible panel docked to the canvas's left edge has two tabs:

- **History** — every chat in the active session, newest first. Each
  row links back to the source shape on the canvas (click the header
  to focus it). Plain transcripts can also be pasted in via drop on
  the panel — useful for stashing notes that aren't tied to a shape.
- **Terms** — concepts, names, and book titles flagged in any
  assistant response. Filter by kind, then drag a chip onto the canvas
  to drop it as a text shape (with the chip's color preserved).

Selecting text inside a chat bubble and dragging it lands the
selection on the canvas as a new text shape. If the source shape is
known (because you dragged from a chat tied to it), the new shape is
auto-connected as a flowchart child of the source.

**Flowchart connections**

Drop one text shape onto another to draw a parent → child arrow.
Dragging a parent moves its children with it. Hover an arrow's
midpoint to delete it. Edges persist with the canvas state.

## Cross-app clipboard (`canvas-clipboard@1`)

Steiner shares its canvas engine with [Hush](https://github.com/laffan/hush),
so copy/paste round-trips between the two. Both apps put a JSON
envelope on the system clipboard as `text/plain`:

```json
{
  "schema": "canvas-clipboard@1",
  "shapes": [ /* full shape objects, including text/image/drag-area */ ],
  "flowEdges": [ { "id": "...", "from": "...", "to": "..." } ]
}
```

**Producer rules (when copying):**

- `shapes` — every shape in the current selection, deep-cloned with
  original IDs intact. Field naming matches the in-memory `Shape`
  types (camelCase).
- `flowEdges` — only edges whose `from` and `to` are *both* in the
  copy set. Orphan edges are dropped at copy time.
- Unknown future fields are allowed; receivers must ignore what they
  don't understand.

**Consumer rules (when pasting):**

1. Cheap header check — only attempt JSON.parse when the clipboard
   text starts with `{` and contains `"canvas-clipboard@1"`.
2. Validate `schema === "canvas-clipboard@1"` and
   `Array.isArray(shapes)`.
3. **Regenerate every shape ID** to avoid colliding with shapes
   already on the receiver. Build an `oldId → newId` map.
4. Remap `parentId` references through the map; clear `parentId` if
   the parent isn't in the paste set.
5. Clear `groupId` so pasted shapes don't accidentally join an
   existing group.
6. Rewrite each `flowEdge` with a fresh `id` and remapped
   `from` / `to`. Drop edges whose endpoints aren't both in the map.
7. Translate every shape's `position` so the paste's bounding-box
   center lands at the canvas viewport center.
8. Append the new shapes; add the new edges via the flowchart layer;
   select the pasted shapes.

The reference implementation is [`src/clipboard-format.ts`](./src/clipboard-format.ts)
(`encodeSelection`, `tryDecode`, `remapForPaste`) and the keyboard
wiring in [`src/input-handler.ts`](./src/input-handler.ts) — Cmd/Ctrl+C,
Cmd/Ctrl+X, plus an explicit Cmd/Ctrl+V handler that reads the
clipboard via `navigator.clipboard.readText()` (browsers don't
reliably dispatch the `paste` event on a non-editable canvas page).
Mirroring the same four hooks in Hush is the entire integration.

**Versioning**: the `@1` suffix is the format version. Breaking
shape-schema changes bump it (`canvas-clipboard@2`); additive fields
don't. Receivers compare the full string for equality, not parse it.

## Build & run

Prerequisites:

- Node 18+ and npm
- (Desktop only) macOS with Xcode command-line tools, Rust 1.77+
  (`rustup`), and the Tauri toolchain
  (see <https://v2.tauri.app/start/prerequisites/>)

```bash
npm install
npm run setup:assets   # one-time: fetch fonts + app icons (see below)

npm run dev            # http://localhost:5173 — pure browser build, no IPC
npm run tauri:dev      # Desktop build with hot reload
npm run tauri:build    # production .app + .dmg
```

`npm run dev` spins up the same code path the GitHub Pages deploy uses
(localStorage persistence, Anthropic API direct from the browser), so
it's useful for iterating on the web target without rebuilding the
Rust crate.

### Asset fetching

The repo intentionally does **not** check in binary assets — the woff2
fonts under `public/fonts/` and the app icons under `src-tauri/icons/`.
They're unchanged from the upstream
[tauri-drawing](https://github.com/laffan/tauri-drawing) project.
`npm run setup:assets` runs `scripts/fetch-assets.mjs`, which downloads
them from `raw.githubusercontent.com/laffan/tauri-drawing/main/...`.
The script is idempotent — re-running it skips files already on disk.

To use your own icon, run `npx tauri icon path/to/source.png` after
the asset fetch (it overwrites the icon set).

## Web build (GitHub Pages)

The same source tree builds to a static web app that runs in any
browser — no Tauri, no native code. Sessions and settings live in
`localStorage`; **Ask Claude** calls the Anthropic API directly using
a key the user pastes into Settings → General.

```bash
npm run build:web      # produces dist/ that can be hosted anywhere static
npm run preview        # smoke-test the bundle on http://localhost:4173
```

The repo includes a GitHub Actions workflow at
[`.github/workflows/pages.yml`](./.github/workflows/pages.yml) that
builds and publishes `dist/` to GitHub Pages on every push to `main`.
To enable:

1. Repo **Settings → Pages → Source**: GitHub Actions.
2. Push to `main`. The site deploys to
   `https://<user>.github.io/<repo>/`.

What the web build does **not** include (vs. desktop):

- No native child webviews — the **Chat** (claude.ai) and
  **Wikipedia** sidebar tabs are hidden.
- No Dropbox sync (the OAuth flow uses a `steiner://` redirect URI
  that only registers from the desktop app).
- No filesystem export — exports route through a browser download
  instead.

Everything else — canvas, sessions, Ask Claude, flowchart layer,
chat-history panel, term extraction, exports, clipboard format —
works identically in both targets. Improvements made in `src/` ship to
both builds without modification; desktop-only features guard
themselves behind `IS_TAURI` from `src/runtime.ts`.

**Anthropic API key on web** is stored in
`localStorage["steiner.web.settings"]` and sent directly to
`api.anthropic.com` with the
`anthropic-dangerous-direct-browser-access: true` header. There's no
proxy server — anyone who can read the user's `localStorage` can read
the key. Acceptable for a personal-use deploy; **do not** ship this
build to a multi-tenant origin.

## Keyboard shortcuts

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| **⌘C / ⌘X**    | Copy / cut selected canvas shapes (`canvas-clipboard@1`)|
| **⌘V**         | Paste shapes (envelope) or text/image (fallback)        |
| **⌘B**         | Wrap selection in `**bold**` while editing text         |
| **⌘I**         | Wrap selection in `*italic*` while editing text         |
| **⌘⇧H**        | Wrap selection in `==highlight==` while editing text    |
| **⌘Z / ⌘⇧Z**   | Undo / redo                                             |
| **T**          | Text tool                                               |
| **A**          | Drag-area tool                                          |
| **B**          | Toggle brainstorm mode                                  |
| **Space + drag** | Pan camera                                            |
| (canvas)       | All other shortcuts inherited from tauri-drawing        |

## Inherited canvas features

The canvas is the full [tauri-drawing](https://github.com/laffan/tauri-drawing)
engine — see its README for pan/zoom, brainstorm mode, drag areas,
themes, undo/redo, the shelf, and the pocket. Steiner adds sessions,
the chat-history / Terms panel, the Ask-Claude flow, the flowchart
layer, and the cross-app clipboard format.
