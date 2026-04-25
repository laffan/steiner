import type { Shape } from "./types";
import { DrawingState } from "./state";
import { render } from "./renderer";
import { bindInputEvents } from "./input-handler";
import { createToolbar } from "./ui/toolbar";
import { createSelectionToolbar } from "./ui/selection-toolbar";
import { createShelfPanel } from "./ui/shelf-panel";
import { createTextEditor } from "./ui/text-editor";
import { createBrainstormInput } from "./ui/brainstorm-input";
import { createStatusBar } from "./ui/status-bar";
import { createSettingsPanel } from "./ui/settings-panel";
import { createFilePanel } from "./ui/file-panel";
import { h } from "./ui/dom-helpers";

export class NotesCanvas {
  readonly container: HTMLElement;
  readonly state: DrawingState;

  private _canvas: HTMLCanvasElement;
  private _rafId = 0;
  private _imageCache = new Map<string, HTMLImageElement>();
  private _cleanupInput: (() => void) | null = null;
  private _shelfItems: string[] = [];
  private _shelfPanel: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = new DrawingState();

    // Set up container styles
    Object.assign(container.style, {
      position: "relative",
      width: "100%",
      height: "100%",
      overflow: "hidden",
      background: "#f4f5f7",
    });

    // Create canvas
    this._canvas = document.createElement("canvas");
    Object.assign(this._canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      touchAction: "none",
    });
    container.appendChild(this._canvas);

    // Store canvas ref in state for pointer handlers
    this.state.canvasEl = this._canvas;

    // Bind input events
    this._cleanupInput = bindInputEvents(this._canvas, this.state, {
      onShelfDrop: (idx, x, y) => {
        if (idx < 0 || idx >= this._shelfItems.length) return;
        const text = this._shelfItems[idx];
        this.state.addTextShapeAtPosition(text, { x, y });
        this._shelfItems.splice(idx, 1);
        this._rebuildShelf();
      },
    });

    // Update cursor on tool change
    const cursorMap: Record<string, string> = {
      select: "default", text: "text", "drag-area": "crosshair", brainstorm: "text",
    };
    this.state.addEventListener("change", () => {
      if (this.state.isPanning) this._canvas.style.cursor = "grab";
      else this._canvas.style.cursor = this.state.brainstormMode ? "text" : (cursorMap[this.state.tool] || "default");
    });

    // Image cache management
    this.state.addEventListener("change", () => this._syncImageCache());

    // Apply theme to container
    this.state.addEventListener("change", () => {
      const t = this.state.theme;
      container.style.background = t.canvasBackground;
    });

    // Build UI
    const shelfCallbacks = {
      shelfItems: this._shelfItems,
      onRemoveShelfItem: (i: number) => {
        this._shelfItems.splice(i, 1);
        this._rebuildShelf();
      },
      onRestoreShelfItem: (i: number) => {
        const text = this._shelfItems[i];
        this.state.addTextShapeAtCenter(text);
        this._shelfItems.splice(i, 1);
        this._rebuildShelf();
      },
    };

    container.appendChild(createSelectionToolbar(this.state, () => this._moveToShelf()));
    container.appendChild(createTextEditor(this.state));
    container.appendChild(createBrainstormInput(this.state));
    container.appendChild(createToolbar(this.state));

    // Top-center bar for bookmarks, settings, and file buttons
    const topBar = h("div", {
      style: {
        position: "absolute", top: "calc(12px + env(safe-area-inset-top))", left: "50%", transform: "translateX(-50%)",
        zIndex: "200", display: "flex", gap: "4px", pointerEvents: "auto",
      },
      children: [createSettingsPanel(this.state, container), createFilePanel(this.state)],
    });
    topBar.addEventListener("pointerdown", (e) => e.stopPropagation());
    container.appendChild(topBar);

    this._shelfPanel = createShelfPanel(this.state, shelfCallbacks);
    container.appendChild(this._shelfPanel);
    container.appendChild(createStatusBar(this.state));

    // Initialize undo history with empty canvas
    this.state.initHistory();

    // Start render loop
    this._startRenderLoop();
  }

  // === Public API ===

  loadShapes(shapes: Shape[]) {
    this.state.shapes = shapes;
    this.state.initHistory();
    this.state.notify("shapes");
  }

  getShapes(): Shape[] {
    return this.state.shapes;
  }

  on(event: string, handler: (detail: unknown) => void) {
    this.state.addEventListener(event, ((e: CustomEvent) => handler(e.detail)) as EventListener);
  }

  destroy() {
    cancelAnimationFrame(this._rafId);
    if (this._cleanupInput) this._cleanupInput();
    this.container.innerHTML = "";
  }

  // === Private ===

  private _startRenderLoop() {
    const loop = () => {
      render(this._canvas, {
        shapes: this.state.shapes,
        selectedIds: this.state.selectedIds,
        camera: this.state.camera,
        selectionBox: this.state.selectionBox,
        creatingDragArea: this.state.creatingDragArea,
        editingShapeId: this.state.editingText?.shapeId ?? null,
        imageCache: this._imageCache,
        theme: this.state.theme,
        croppingImageId: this.state.croppingImageId,
        fontFamily: this.state.fontFamily,
        backgroundPattern: this.state.backgroundPattern,
        gridSpacing: this.state.gridSpacing,
        gridOpacity: this.state.gridOpacity,
        isDragging: this.state.isActiveDrag,
      });
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _syncImageCache() {
    for (const shape of this.state.shapes) {
      if (shape.type === "image" && !this._imageCache.has(shape.id)) {
        const img = new Image();
        img.src = shape.dataUrl;
        this._imageCache.set(shape.id, img);
      }
    }
    const ids = new Set(this.state.shapes.filter((s) => s.type === "image").map((s) => s.id));
    for (const id of this._imageCache.keys()) {
      if (!ids.has(id)) this._imageCache.delete(id);
    }
  }

  private _moveToShelf() {
    const texts = this.state.moveSelectedToShelf();
    if (texts.length > 0) {
      this._shelfItems.unshift(...texts);
      this._rebuildShelf();
    }
  }

  private _rebuildShelf() {
    // Force a state change notification so shelf rebuilds
    this.state.notify("shapes");
  }
}
