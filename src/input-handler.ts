import type { DrawingState } from "./state";
import {
  cleanLineBreaks, extractDroppedText, extractTextFromDataTransfer,
  fileToDataUrl, getImageDimensions, isImageFile, isTextFile,
} from "./external-content";
import { screenToCanvas, getShapeBounds } from "./utils";
import { CLIPBOARD_SCHEMA, encodeSelection, tryDecode, remapForPaste } from "./clipboard-format";
import { htmlStringToMarkdown } from "./html-to-markdown";
import { HIGHLIGHT_STYLE } from "./ui/chat-bubble";

export interface InputOptions {
  onShelfDrop?: (index: number, x: number, y: number) => void;
}

export function bindInputEvents(canvas: HTMLCanvasElement, state: DrawingState, inputOpts?: InputOptions): () => void {
  const cleanups: (() => void)[] = [];

  function on<K extends keyof HTMLElementEventMap>(
    el: EventTarget, type: K, handler: (e: HTMLElementEventMap[K]) => void, listenerOpts?: AddEventListenerOptions,
  ) {
    el.addEventListener(type, handler as EventListener, listenerOpts);
    cleanups.push(() => el.removeEventListener(type, handler as EventListener, listenerOpts));
  }

  // Canvas pointer events
  on(canvas, "pointerdown", (e) => state.handlePointerDown(e));
  on(canvas, "pointermove", (e) => state.handlePointerMove(e));
  on(canvas, "pointerup", (e) => state.handlePointerUp(e));
  on(canvas, "dblclick", (e) => state.handleDoubleClick(e));
  on(canvas, "wheel", (e) => state.handleWheel(e), { passive: false });

  // Two-finger touch to pan (like Space+drag)
  let twoFingerPanning = false;
  let twoFingerStart = { x: 0, y: 0 };
  let cameraAtTwoFingerStart = { x: 0, y: 0, zoom: 1 };

  on(canvas, "touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      twoFingerPanning = true;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      twoFingerStart = { x: midX, y: midY };
      cameraAtTwoFingerStart = { ...state.camera };
    }
  }, { passive: false });

  on(canvas, "touchmove", (e) => {
    if (twoFingerPanning && e.touches.length === 2) {
      e.preventDefault();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = midX - twoFingerStart.x;
      const dy = midY - twoFingerStart.y;
      state.camera = {
        x: cameraAtTwoFingerStart.x + dx,
        y: cameraAtTwoFingerStart.y + dy,
        zoom: cameraAtTwoFingerStart.zoom,
      };
      state.notify("camera");
    }
  }, { passive: false });

  on(canvas, "touchend", (e) => {
    if (twoFingerPanning && e.touches.length < 2) {
      twoFingerPanning = false;
    }
  });

  // Space-to-pan state
  let spaceDown = false;
  let toolBeforeSpace: string | null = null;

  // Keyboard shortcuts
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    if (state.editingText) {
      if (e.key === "Escape") {
        state.commitText(state.editingText);
        state.editingText = null;
        state.notify("editingText");
      }
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Space-to-pan: hold space to temporarily pan
    if (e.key === " " && !e.repeat) {
      e.preventDefault();
      spaceDown = true;
      toolBeforeSpace = state.tool;
      state.isPanning = true;
      state.notify("tool"); // triggers cursor update
      return;
    }

    switch (e.key) {
      case "1": state.tool = "select"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); break;
      case "t": case "T": state.tool = "text"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); break;
      case "a": case "A":
        if (!e.ctrlKey && !e.metaKey) { state.tool = "drag-area"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); }
        break;
      case "b": case "B":
        if (!e.ctrlKey && !e.metaKey) {
          state.brainstormMode = !state.brainstormMode;
          if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
          state.notify("brainstormMode");
        }
        break;
      case "Delete": case "Backspace": state.deleteSelected(); break;
      case "g": case "G":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) state.ungroupSelected();
          else state.groupSelected();
        }
        break;
      case "z": case "Z":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) state.redo();
          else state.undo();
        }
        break;
      case "y": case "Y":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          state.redo();
        }
        break;
      case "c": case "C":
        if (e.metaKey || e.ctrlKey && !e.shiftKey) {
          // Don't hijack the system copy when text is being edited.
          if (document.activeElement instanceof HTMLInputElement) break;
          if (document.activeElement instanceof HTMLTextAreaElement) break;
          if (state.editingText) break;
          if (copySelectionToClipboard(state)) e.preventDefault();
        }
        break;
      case "x": case "X":
        if (e.metaKey || e.ctrlKey) {
          if (document.activeElement instanceof HTMLInputElement) break;
          if (document.activeElement instanceof HTMLTextAreaElement) break;
          if (state.editingText) break;
          if (copySelectionToClipboard(state)) {
            e.preventDefault();
            state.deleteSelected();
          }
        }
        break;
      case "v": case "V":
        // The browser only fires `paste` reliably when an editable element
        // (input/textarea/contenteditable) is focused. The canvas page has no
        // such element by default, so Cmd+V silently no-ops. Read the
        // clipboard ourselves via the async API; the existing `paste` event
        // listener stays as a fallback for when a paste *is* dispatched
        // (e.g. native Edit > Paste menu in Tauri), and the two paths dedupe
        // on `lastPasteAt`.
        if (e.metaKey || e.ctrlKey) {
          if (document.activeElement instanceof HTMLInputElement) break;
          if (document.activeElement instanceof HTMLTextAreaElement) break;
          if (state.editingText) break;
          e.preventDefault();
          void asyncCanvasPaste(state, canvas);
        }
        break;
    }
  }) as unknown as (e: HTMLElementEventMap["keydown"]) => void);

  on(window as unknown as HTMLElement, "keyup", ((e: KeyboardEvent) => {
    if (e.key === " " && spaceDown) {
      spaceDown = false;
      state.isPanning = false;
      if (toolBeforeSpace) {
        state.tool = toolBeforeSpace as import("./types").Tool;
        toolBeforeSpace = null;
      }
      state.notify("tool");
    }
  }) as unknown as (e: HTMLElementEventMap["keyup"]) => void);

  // Paste — runs when the browser dispatches a `paste` event (typically only
  // when an editable element is focused). The Cmd+V keydown handler above
  // covers the canvas-focused case via the async clipboard API. Both share
  // `lastPasteAt` to avoid double-pasting if both fire.
  on(document as unknown as HTMLElement, "paste", (async (e: ClipboardEvent) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    if (state.editingText) return;
    e.preventDefault();
    if (recentlyPasted()) return;
    const cd = e.clipboardData;
    if (!cd) return;

    const rawText = extractTextFromDataTransfer(cd);
    const env = tryDecode(rawText);
    if (env) {
      markPasted();
      pasteEnvelope(env, state, canvas);
      return;
    }

    for (const item of Array.from(cd.items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          markPasted();
          const dataUrl = await fileToDataUrl(file);
          const dims = await getImageDimensions(dataUrl);
          state.addImageShape(dataUrl, file.name, dims.width, dims.height);
          return;
        }
      }
    }
    if (rawText && rawText.trim()) {
      markPasted();
      state.addTextShapeAtCenter(cleanLineBreaks(rawText));
    }
  }) as unknown as (e: HTMLElementEventMap["paste"]) => void);

  // Drag/drop — capture phase so preventDefault() runs before the browser
  // rejects the drop target. Handles shelf items, file drops, and text drops.
  on(window as unknown as HTMLElement, "dragover", ((e: DragEvent) => {
    // Let panels with their own drop targets (e.g. the chat history transcript
    // drop zone) handle the drag themselves.
    const t = e.target as Element | null;
    if (t && t.closest("[data-steiner-drop]")) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-shelf-index") ? "move" : "copy";
    }
  }) as unknown as (e: HTMLElementEventMap["dragover"]) => void, { capture: true });

  on(window as unknown as HTMLElement, "drop", (async (e: DragEvent) => {
    const t = e.target as Element | null;
    if (t && t.closest("[data-steiner-drop]")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer) return;
    const rect = canvas.getBoundingClientRect();
    const dropPos = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);

    // Shelf item drag-to-restore
    const shelfIdx = e.dataTransfer.getData("application/x-shelf-index");
    if (shelfIdx !== "") {
      inputOpts?.onShelfDrop?.(parseInt(shelfIdx, 10), dropPos.x, dropPos.y);
      return;
    }

    // Ask-Claude response drop: carries source shape IDs so we can link via flowchart.
    const askPayload = (() => {
      try { return e.dataTransfer.getData("application/x-steiner-ask"); }
      catch { return ""; }
    })();
    if (askPayload) {
      try {
        const parsed = JSON.parse(askPayload) as {
          sourceShapeIds?: string[];
          text?: string;
          kind?: "concept" | "name" | "book" | "definition";
        };
        const text = (parsed.text || "").trim();
        if (text) {
          const before = new Set(state.shapes.map((s) => s.id));
          // Defer history recording: we may also add a flowchart edge and
          // reposition the shape below — capture the post-edge state as one
          // undo step.
          state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos, { record: false });
          const newShape = state.shapes.find((s) => !before.has(s.id));
          // Term chips carry a `kind`. Apply the matching highlight style so
          // a dropped term keeps the same visual identity it had in the chat
          // panel (concept = yellow, name = blue, book = purple/italic,
          // definition = green).
          if (newShape && parsed.kind) {
            const styleSpec = HIGHLIGHT_STYLE[parsed.kind];
            if (styleSpec) {
              const fg = (styleSpec.color as string) || "#000000";
              const bg = (styleSpec.background as string) || "#ffffff";
              state.shapes = state.shapes.map((s) =>
                s.id === newShape.id && s.type === "text"
                  ? { ...s, color: fg, backgroundColor: bg }
                  : s,
              );
            }
          }
          const sourceId = parsed.sourceShapeIds?.[0];
          if (newShape && sourceId) {
            // tryConnect both adds the edge AND computes the auto-position
            // (right of parent, stacked below existing siblings). Translate
            // the new shape from the drop point to that slot.
            const newTL = state.flowchart.tryConnect(newShape.id, sourceId, state.shapes);
            if (newTL) {
              const oldBounds = getShapeBounds(newShape);
              const dx = newTL.minX - oldBounds.minX;
              const dy = newTL.minY - oldBounds.minY;
              if (dx !== 0 || dy !== 0) {
                state.shapes = state.shapes.map((s) => {
                  if (s.id !== newShape.id) return s;
                  if (s.type === "text" || s.type === "image" || s.type === "drag-area") {
                    return { ...s, position: { x: s.position.x + dx, y: s.position.y + dy } };
                  }
                  return s;
                });
              }
            }
            state.recordHistory();
            state.notify("shapes");
            // Pan the camera so the auto-positioned node lands in view.
            state.focusShape(newShape.id);
          } else {
            state.recordHistory();
            state.notify("shapes");
          }
        }
        return;
      } catch {
        // Fall through to normal handlers if payload is malformed.
      }
    }

    // File drops (images, text)
    const files = Array.from(e.dataTransfer.files);
    let handledFile = false;
    for (const file of files) {
      if (isImageFile(file)) {
        const dataUrl = await fileToDataUrl(file);
        const dims = await getImageDimensions(dataUrl);
        state.addImageShape(dataUrl, file.name, dims.width, dims.height, dropPos);
        handledFile = true;
      } else if (isTextFile(file)) {
        const text = await file.text();
        if (text.trim()) state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos);
        handledFile = true;
      }
    }
    if (handledFile) return;

    // Prefer HTML so that selections dragged from claude.ai (or any rich
    // source) keep their formatting via markdown conversion.
    const html = (() => {
      try {
        return e.dataTransfer.getData("text/html");
      } catch {
        return "";
      }
    })();
    if (html && html.trim()) {
      const md = htmlStringToMarkdown(html);
      if (md) {
        state.addTextShapeAtPosition(md, dropPos);
        return;
      }
    }
    const text = await extractDroppedText(e.dataTransfer);
    if (text && text.trim()) state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos);
  }) as unknown as (e: HTMLElementEventMap["drop"]) => void, { capture: true });

  return () => { for (const fn of cleanups) fn(); };
}

function copySelectionToClipboard(state: import("./state").DrawingState): boolean {
  const selected = state.shapes.filter((s) => state.selectedIds.has(s.id));
  if (selected.length === 0) return false;
  const payload = encodeSelection(selected, state.flowchart.edges);
  // Best-effort clipboard write. The async API requires a secure context
  // (Tauri's webview, https://, or localhost). Failures are swallowed rather
  // than trapping the keyboard shortcut — there's no good fallback we can
  // run synchronously inside a keydown handler.
  void navigator.clipboard.writeText(payload).catch(() => {
    /* clipboard unavailable */
  });
  return true;
}

// Dedupe between the keydown Cmd+V path and the document `paste` listener:
// browsers vary on whether they dispatch `paste` when nothing editable is
// focused, so we always run the keydown path and skip the paste-event work
// if it already ran (or vice-versa).
let lastPasteAt = 0;
const PASTE_DEDUP_MS = 400;
function markPasted() {
  lastPasteAt = Date.now();
}
function recentlyPasted(): boolean {
  return Date.now() - lastPasteAt < PASTE_DEDUP_MS;
}

async function asyncCanvasPaste(
  state: import("./state").DrawingState,
  canvas: HTMLCanvasElement,
) {
  if (recentlyPasted()) return;
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Permission denied or insecure context. The paste event listener may
    // still fire and pick this up; nothing more we can do here.
    return;
  }

  const env = tryDecode(text);
  if (env) {
    markPasted();
    pasteEnvelope(env, state, canvas);
    return;
  }

  // navigator.clipboard.read() returns image blobs on browsers that support
  // it (Chrome/Edge — Safari only on macOS 13.1+). Best-effort; failures
  // fall through to the plain-text path.
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith("image/")) {
          const blob = await item.getType(type);
          const dataUrl = await blobToDataUrl(blob);
          const dims = await getImageDimensions(dataUrl);
          markPasted();
          state.addImageShape(dataUrl, "pasted-image", dims.width, dims.height);
          return;
        }
      }
    }
  } catch {
    // clipboard.read() unsupported — that's fine, fall through.
  }

  if (text && text.trim()) {
    markPasted();
    state.addTextShapeAtCenter(cleanLineBreaks(text));
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Failed to read blob"));
    r.readAsDataURL(blob);
  });
}

function pasteEnvelope(
  env: ReturnType<typeof tryDecode> & object,
  state: import("./state").DrawingState,
  canvas: HTMLCanvasElement,
) {
  if (!env) return;
  // Paste at the canvas viewport center in canvas coordinates.
  const rect = canvas.getBoundingClientRect();
  const screenCenter = { x: rect.width / 2, y: rect.height / 2 };
  const target = screenToCanvas(screenCenter, state.camera);

  const { shapes: pasted, edges, newIds } = remapForPaste(env, target);
  if (pasted.length === 0) return;

  state.shapes = [...state.shapes, ...pasted];
  for (const e of edges) {
    state.flowchart.addEdge(e.from, e.to);
  }
  state.selectedIds = new Set(newIds);
  state.recordHistory();
  state.notify("shapes");
  state.notify("selectedIds");
}

// Re-export to keep the unused-import lint quiet on platforms where the
// module-side check optimizes out the constant.
void CLIPBOARD_SCHEMA;
