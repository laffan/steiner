// Steiner bridge: wires the canvas (right-pane webview) to the Tauri backend.
//
// Responsibilities
//   • Receive pinned snippets from the claude.ai webview (forwarded by Rust).
//   • Forward "send to Claude" requests from the canvas to Rust → claude webview.
//   • Persist canvas state (shapes + snippet metadata) and restore on startup.
//
// The metadata for each pinned snippet (URL, timestamp, context) is kept in a
// parallel map keyed by the canvas shape id. Per the spec the metadata is
// captured but not displayed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NotesCanvas } from "./notes-canvas";
import type { Shape, TextShape } from "./types";
import { screenToCanvas } from "./utils";
import type { FlowEdge } from "./flowchart";

export interface PinnedSnippet {
  id: string;
  text: string;
  url: string;
  timestamp: string;
  context: string;
}

export interface SnippetMeta {
  url: string;
  timestamp: string;
  context: string;
  /** Original snippet id from the claude webview. */
  pinId: string;
}

interface PersistedState {
  shapes: Shape[];
  snippetMeta: Record<string, SnippetMeta>;
  flowEdges?: FlowEdge[];
}

const SAVE_DEBOUNCE_MS = 400;

export class SteinerBridge {
  private canvas: NotesCanvas;
  private container: HTMLElement;
  private snippetMeta = new Map<string, SnippetMeta>();
  private pending: PinnedSnippet | null = null;
  private ghostEl: HTMLElement | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: Array<() => void> = [];

  constructor(canvas: NotesCanvas) {
    this.canvas = canvas;
    this.container = canvas.container;
  }

  async init() {
    await this.restoreState();
    this.installListeners();
    this.installDivider();
  }

  destroy() {
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    this.removeGhost();
  }

  /** Get metadata for a shape (if it was pinned from claude.ai). */
  getMeta(shapeId: string): SnippetMeta | undefined {
    return this.snippetMeta.get(shapeId);
  }

  /**
   * Send the given text to Claude. Returns true if the input was injected,
   * false if it fell back to the clipboard.
   */
  async sendToClaude(text: string, submit: boolean): Promise<boolean> {
    try {
      const ok = await invoke<boolean>("send_to_claude", { text, submit });
      if (!ok) {
        await this.copyToClipboard(text);
        this.flashCanvasToast("Couldn't reach Claude — copied to clipboard");
      }
      return !!ok;
    } catch (err) {
      console.warn("[steiner] send_to_claude failed", err);
      await this.copyToClipboard(text);
      this.flashCanvasToast("Send failed — copied to clipboard");
      return false;
    }
  }

  // --- Internal ---

  private async restoreState() {
    try {
      const state = await invoke<PersistedState | null>("load_canvas_state");
      if (!state) return;
      if (Array.isArray(state.shapes)) {
        this.canvas.loadShapes(state.shapes);
      }
      if (state.snippetMeta && typeof state.snippetMeta === "object") {
        for (const [id, meta] of Object.entries(state.snippetMeta)) {
          this.snippetMeta.set(id, meta as SnippetMeta);
        }
      }
      this.canvas.state.flowchart.deserialize(state.flowEdges);
    } catch (err) {
      console.warn("[steiner] restore failed", err);
    }
  }

  private installListeners() {
    // Persist on every shape mutation (debounced).
    const handleChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { keys?: string[] } | undefined;
      if (!detail?.keys?.includes("shapes")) return;
      this.scheduleSave();
    };
    this.canvas.state.addEventListener("change", handleChange);
    this.cleanups.push(() =>
      this.canvas.state.removeEventListener("change", handleChange),
    );

    // Pinned snippet from claude webview.
    listen<PinnedSnippet>("snippet-pinned", (event) => {
      this.beginPlacement(event.payload);
    }).then((unlisten) => this.cleanups.push(unlisten));

    // Track cursor for the ghost preview.
    const onMouseMove = (e: MouseEvent) => this.updateGhost(e.clientX, e.clientY);
    window.addEventListener("mousemove", onMouseMove);
    this.cleanups.push(() => window.removeEventListener("mousemove", onMouseMove));

    // Click anywhere on the canvas container places the pending pin.
    // Use capture phase so we run before the canvas's own pointer handlers.
    const onPointerDown = (e: PointerEvent) => {
      if (!this.pending || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.placePending(e.clientX, e.clientY);
    };
    this.container.addEventListener("pointerdown", onPointerDown, { capture: true });
    this.cleanups.push(() =>
      this.container.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      } as EventListenerOptions),
    );

    // Escape cancels a pending pin.
    const onKeyDown = (e: KeyboardEvent) => {
      if (this.pending && e.key === "Escape") {
        e.preventDefault();
        this.cancelPending();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    this.cleanups.push(() => window.removeEventListener("keydown", onKeyDown));
  }

  private beginPlacement(snippet: PinnedSnippet) {
    this.pending = snippet;
    this.ensureGhost();
    if (this.ghostEl) {
      this.ghostEl.textContent = snippet.text;
    }
    // If the user hasn't moved the mouse yet, anchor the ghost in the middle.
    const rect = this.container.getBoundingClientRect();
    this.updateGhost(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  private placePending(clientX: number, clientY: number) {
    if (!this.pending) return;
    const rect = this.canvas.state.canvasEl?.getBoundingClientRect();
    if (!rect) {
      this.cancelPending();
      return;
    }
    const screenPt = { x: clientX - rect.left, y: clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.canvas.state.camera);
    const before = new Set(this.canvas.state.shapes.map((s) => s.id));
    this.canvas.state.addTextShapeAtPosition(this.pending.text, canvasPt);
    const newShape = this.canvas.state.shapes.find((s) => !before.has(s.id));
    if (newShape) {
      this.snippetMeta.set(newShape.id, {
        url: this.pending.url,
        timestamp: this.pending.timestamp,
        context: this.pending.context,
        pinId: this.pending.id,
      });
    }
    this.pending = null;
    this.removeGhost();
    this.scheduleSave();
  }

  private cancelPending() {
    this.pending = null;
    this.removeGhost();
  }

  // Pinned to the canvas webview's left edge — which is the seam between
  // the two webviews in the parent window. Drag-deltas are forwarded to
  // Rust, which re-layouts both webviews. Using e.movementX (raw pointer
  // delta) rather than clientX — avoids the race where the canvas shifts
  // mid-drag and clientX no longer reflects intent.
  private installDivider() {
    const HOT_W = 6; // hover hit-area width
    const VIS_W = 1; // visible line width (centered in hit-area)
    const el = document.createElement("div");
    el.title = "Drag to resize panes";
    Object.assign(el.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${HOT_W}px`,
      height: "100vh",
      cursor: "ew-resize",
      zIndex: "10001",
      background: "transparent",
    } as Partial<CSSStyleDeclaration>);
    const line = document.createElement("div");
    Object.assign(line.style, {
      position: "absolute",
      left: `${(HOT_W - VIS_W) / 2}px`,
      top: "0",
      width: `${VIS_W}px`,
      height: "100%",
      background: "rgba(0,0,0,0.18)",
      transition: "background 0.15s ease",
    } as Partial<CSSStyleDeclaration>);
    el.appendChild(line);
    el.addEventListener("mouseenter", () => {
      line.style.background = "rgba(0,0,0,0.4)";
    });
    el.addEventListener("mouseleave", () => {
      line.style.background = "rgba(0,0,0,0.18)";
    });

    let dragging = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      el.setPointerCapture(e.pointerId);
      document.body.style.cursor = "ew-resize";
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (e.movementX === 0) return;
      invoke("nudge_split", { deltaPixels: e.movementX }).catch(() => {});
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      document.body.style.cursor = "";
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);

    document.body.appendChild(el);
    this.cleanups.push(() => el.remove());
  }

  private ensureGhost() {
    if (this.ghostEl) return;
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      left: "0",
      top: "0",
      maxWidth: "320px",
      padding: "8px 10px",
      background: "rgba(255,236,179,0.95)",
      color: "#222",
      borderRadius: "6px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
      fontSize: "13px",
      lineHeight: "1.35",
      pointerEvents: "none",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      zIndex: "9999",
      transform: "translate(12px, 12px)",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    this.ghostEl = el;
  }

  private updateGhost(clientX: number, clientY: number) {
    if (!this.ghostEl) return;
    this.ghostEl.style.left = `${clientX}px`;
    this.ghostEl.style.top = `${clientY}px`;
  }

  private removeGhost() {
    if (this.ghostEl && this.ghostEl.parentNode) {
      this.ghostEl.parentNode.removeChild(this.ghostEl);
    }
    this.ghostEl = null;
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save() {
    const shapes = this.canvas.getShapes();
    // Drop metadata for shapes that no longer exist.
    const live = new Set(shapes.map((s) => s.id));
    for (const id of Array.from(this.snippetMeta.keys())) {
      if (!live.has(id)) this.snippetMeta.delete(id);
    }
    const payload: PersistedState = {
      shapes,
      snippetMeta: Object.fromEntries(this.snippetMeta),
      flowEdges: this.canvas.state.flowchart.serialize(),
    };
    try {
      await invoke("save_canvas_state", { state: payload });
    } catch (err) {
      console.warn("[steiner] save failed", err);
    }
  }

  private async copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Best-effort; nothing else to do.
    }
  }

  private flashCanvasToast(msg: string) {
    const existing = document.getElementById("__steiner_canvas_toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "__steiner_canvas_toast";
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "10px 16px",
      background: "rgba(20,20,20,0.92)",
      color: "#fff",
      fontSize: "13px",
      borderRadius: "8px",
      zIndex: "10000",
      pointerEvents: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }
}

/** Concatenate selected text shapes into one Claude-ready prompt. */
export function buildSendPayload(selected: Shape[]): string {
  const texts = selected
    .filter((s): s is TextShape => s.type === "text")
    .map((s) => s.text.trim())
    .filter(Boolean);
  if (texts.length === 0) return "";
  const prefix = "Tell me more about";
  if (texts.length === 1) return `${prefix} ${texts[0]}`;
  const body = texts.map((t, i) => `--- snippet ${i + 1} ---\n${t}`).join("\n\n");
  return `${prefix} the following:\n\n${body}`;
}
