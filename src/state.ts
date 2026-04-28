import type {
  Camera, CameraBookmark, DragAreaShape, ImageShape,
  Point, SelectionBox, Shape, TextShape, Tool,
} from "./types";
import { COLOR_PALETTE } from "./types";
import {
  alignShapes, boundsOverlap, distributeShapes, generateId,
  getShapeBounds, hitTestShape,
  pointInBounds, screenToCanvas,
} from "./utils";
import { UndoManager } from "./undo-manager";
import { isEmojiOnly, emojiToDataUrl } from "./emoji-sticker";

const STICKER_SIZE = 100;
import type { AppearanceMode, CanvasTheme } from "./themes";
import { THEMES, getEffectiveVariant } from "./themes";
import {
  autoFitWidth, findShapeAtPoint, findPocketedShapeAtScreen,
  hitTestLink, normalizeBox, moveShape,
  applyResize, applyCropResize, openExternalUrl,
} from "./state-helpers";
import { computePocketLayout, POCKET_ZONE_WIDTH } from "./utils";
import { FlowchartLayer } from "./flowchart";
import { TIDY_BUTTON_RADIUS, TIDY_BUTTON_GAP } from "./renderer";

export interface EditingText {
  shapeId: string | null;
  position: Point;
  text: string;
  fontSize: number;
  color: string;
  width?: number; // constraint width from existing shape
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const HANDLE_SIZE = 8;

export type BackgroundPattern = "grid" | "dot-grid" | "blank";

type StateKey = "shapes" | "selectedIds" | "tool" | "color"
  | "fontSize" | "camera" | "selectionBox" | "editingText"
  | "bookmarks" | "brainstormMode" | "creatingDragArea" | "theme";

export class DrawingState extends EventTarget {
  shapes: Shape[] = [];
  selectedIds: Set<string> = new Set();
  tool: Tool = "select";
  color = "#000000";
  fontSize = 18;
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  selectionBox: SelectionBox | null = null;
  editingText: EditingText | null = null;
  bookmarks: CameraBookmark[] = [];
  brainstormMode = false;
  creatingDragArea: { start: Point; end: Point } | null = null;

  canvasEl: HTMLCanvasElement | null = null;
  /** When true, left-click pans (set by space bar hold). */
  isPanning = false;
  /** Shape ID currently being cropped, or null */
  croppingImageId: string | null = null;

  /** Flowchart edges between text shapes. Drop a text shape onto another
   * text shape to connect them; arrows render in the canvas. */
  flowchart = new FlowchartLayer<Shape>({
    getBounds: (s) => getShapeBounds(s),
    isFlowable: (s) => s.type === "text",
  });
  /** While dragging a single text shape, the id of the shape under the
   * cursor that would be the drop-connection target (or null). */
  flowDropTargetId: string | null = null;
  /** id of an edge whose curve the cursor is hovering over (or null). */
  flowHoveredEdgeId: string | null = null;
  /** Set by startEditingFlowchartChild before a new shape exists; consumed
   * by commitText to wire the edge once the shape is created. */
  private _pendingFlowParent: string | null = null;
  /** History of recently-edited text-shape ids, oldest first. */
  private _recentEditIds: string[] = [];

  // Appearance
  appearanceMode: AppearanceMode = "light";
  themeId = "default";
  backgroundPattern: BackgroundPattern = "grid";
  gridSpacing = 25;
  gridOpacity = 0.15;
  fontFamily = "Inter";

  get canvasWidth(): number { return this.canvasEl?.clientWidth || window.innerWidth; }
  get isActiveDrag(): boolean { return this._showPocketTray; }

  get theme(): CanvasTheme {
    const variant = getEffectiveVariant(this.appearanceMode);
    const t = THEMES[this.themeId];
    if (t && t.variant === variant) return t;
    // Fallback: pick first theme that matches the requested variant
    const fallback = Object.values(THEMES).find((th) => th.variant === variant);
    return fallback || THEMES["default"];
  }

  setTheme(id: string) { this.themeId = id; this.notify("theme"); }
  setAppearance(mode: AppearanceMode) { this.appearanceMode = mode; this.notify("theme"); }

  // Undo/redo
  private _undo = new UndoManager();

  private _captureSnapshot() {
    return {
      shapes: this.shapes,
      flowEdges: this.flowchart.serialize(),
      selectedIds: Array.from(this.selectedIds),
    };
  }

  private _applySnapshot(snap: { shapes: Shape[]; flowEdges: { id: string; from: string; to: string }[]; selectedIds: string[] }) {
    this.shapes = snap.shapes;
    this.flowchart.deserialize(snap.flowEdges);
    this.selectedIds = new Set(snap.selectedIds);
    this.flowDropTargetId = null;
    this.flowHoveredEdgeId = null;
    this.notify("shapes");
    this.notify("selectedIds");
  }

  /** Record current state as an undo checkpoint. Call after completed actions. */
  recordHistory() { this._undo.record(this._captureSnapshot()); }

  /** Initialize undo history (call after loading shapes). */
  initHistory() { this._undo.init(this._captureSnapshot()); }

  undo() {
    const snapshot = this._undo.undo();
    if (!snapshot) return;
    this._applySnapshot(snapshot);
  }

  redo() {
    const snapshot = this._undo.redo();
    if (!snapshot) return;
    this._applySnapshot(snapshot);
  }

  get canUndo() { return this._undo.canUndo; }
  get canRedo() { return this._undo.canRedo; }

  // Private interaction state (replaces useRef)
  private _isPanningActive = false;
  private _panStart: Point = { x: 0, y: 0 };
  private _cameraStart: Camera = { x: 0, y: 0, zoom: 1 };
  private _selectStart: Point | null = null;
  private _isDragging = false;
  private _dragStart: Point = { x: 0, y: 0 };
  private _isResizing = false;
  private _resizeHandle: ResizeHandle | null = null;
  private _resizeStart: Point = { x: 0, y: 0 };
  private _resizeOrigShape: Shape | null = null;
  private _resizeOrigBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  // Pocket drag state
  private _pocketDragPending = false;
  private _pocketDragScreenStart: Point = { x: 0, y: 0 };
  private _showPocketTray = false;
  private _dragHoldTimer: ReturnType<typeof setTimeout> | null = null;

  // Batched notification
  private _pendingKeys = new Set<string>();
  private _notifyScheduled = false;

  notify(key: StateKey) {
    this._pendingKeys.add(key);
    if (!this._notifyScheduled) {
      this._notifyScheduled = true;
      queueMicrotask(() => {
        this._notifyScheduled = false;
        const keys = Array.from(this._pendingKeys);
        this._pendingKeys.clear();
        this.dispatchEvent(new CustomEvent("change", { detail: { keys } }));
      });
    }
  }

  // === Text ===
  commitText(editing: EditingText): string | null {
    const trimmed = editing.text.trim();
    if (!trimmed) {
      this._pendingFlowParent = null;
      return null;
    }
    // Emoji-only text becomes an image "sticker": rasterize at STICKER_SIZE
    // and swap the shape type so it scales/crops/exports like any image.
    const sticker = isEmojiOnly(trimmed)
      ? { dataUrl: emojiToDataUrl(trimmed, STICKER_SIZE), name: trimmed }
      : null;

    let shapeId: string;
    if (editing.shapeId) {
      shapeId = editing.shapeId;
      this.shapes = this.shapes.map((s) => {
        if (s.id !== editing.shapeId || s.type !== "text") return s;
        if (sticker) {
          const img: ImageShape = {
            id: s.id,
            type: "image",
            position: s.position,
            width: STICKER_SIZE,
            height: STICKER_SIZE,
            dataUrl: sticker.dataUrl,
            name: sticker.name,
            color: s.color,
            parentId: s.parentId,
            groupId: s.groupId,
            pocketed: s.pocketed,
          };
          return img;
        }
        const updated = { ...s, text: trimmed };
        // Auto-shrink width to content if not manually resized
        if (!s.manualWidth) {
          updated.width = autoFitWidth(trimmed, s.fontSize, editing.width, this.fontFamily);
        }
        return updated;
      });
    } else {
      shapeId = generateId();
      if (sticker) {
        this.shapes = [
          ...this.shapes,
          {
            id: shapeId,
            type: "image",
            position: editing.position,
            width: STICKER_SIZE,
            height: STICKER_SIZE,
            dataUrl: sticker.dataUrl,
            name: sticker.name,
            color: editing.color,
          } as ImageShape,
        ];
      } else {
        const fitWidth = autoFitWidth(trimmed, editing.fontSize, editing.width, this.fontFamily);
        this.shapes = [...this.shapes, {
          id: shapeId, type: "text", position: editing.position,
          text: trimmed, fontSize: editing.fontSize, color: editing.color,
          width: fitWidth,
        } as TextShape];
      }
      // Pending flowchart parent (set by startEditingFlowchartChild before
      // user typed) — wire the edge once the new shape exists.
      if (this._pendingFlowParent) {
        this.flowchart.addEdge(this._pendingFlowParent, shapeId);
        this._pendingFlowParent = null;
      }
    }
    this.recordRecentEdit(shapeId);
    this.selectedIds = new Set([shapeId]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
    return shapeId;
  }

  startEditingExistingText(shape: TextShape) {
    this.editingText = {
      shapeId: shape.id, position: shape.position,
      text: shape.text, fontSize: shape.fontSize, color: shape.color,
      // Widen to at least 350 for comfortable editing, unless manually set wider
      width: shape.manualWidth ? shape.width : Math.max(350, shape.width || 0),
    };
    this.recordRecentEdit(shape.id);
    this.notify("editingText");
  }

  // === Flowchart-aware editing shortcuts ===

  /** Open an editor for a brand-new node positioned as a flowchart child of
   * `parentId`. The edge is added by commitText once the user types something. */
  startEditingFlowchartChild(parentId: string) {
    const parent = this.shapes.find((s) => s.id === parentId);
    if (!parent || parent.type !== "text") return;
    const pBounds = getShapeBounds(parent);
    let baseY = pBounds.minY;
    for (const cid of this.flowchart.childrenOf(parentId)) {
      const c = this.shapes.find((s) => s.id === cid);
      if (!c) continue;
      const cb = getShapeBounds(c);
      if (cb.maxY + 16 > baseY) baseY = cb.maxY + 16;
    }
    const newPos: Point = { x: pBounds.maxX + 60, y: baseY };
    this._pendingFlowParent = parentId;
    this.editingText = {
      shapeId: null,
      position: newPos,
      text: "",
      fontSize: parent.fontSize,
      color: parent.color,
      width: 350,
    };
    this.notify("editingText");
  }

  /** Open an editor for a sibling of `currentId` — child of the same parent
   * if one exists; otherwise just a new node directly below current. */
  startEditingFlowchartSibling(currentId: string) {
    const parentId = this.flowchart.parentOf(currentId);
    if (parentId) {
      this.startEditingFlowchartChild(parentId);
      return;
    }
    const cur = this.shapes.find((s) => s.id === currentId);
    if (!cur || cur.type !== "text") return;
    const cb = getShapeBounds(cur);
    this.editingText = {
      shapeId: null,
      position: { x: cur.position.x, y: cb.maxY + 16 },
      text: "",
      fontSize: cur.fontSize,
      color: cur.color,
      width: cur.width ?? 350,
    };
    this.notify("editingText");
  }

  /** Enter edit mode on the flowchart parent of `currentId`, if any. */
  startEditingFlowchartParent(currentId: string): boolean {
    const parentId = this.flowchart.parentOf(currentId);
    if (!parentId) return false;
    const parent = this.shapes.find((s) => s.id === parentId);
    if (!parent || parent.type !== "text") return false;
    this.startEditingExistingText(parent);
    return true;
  }

  /** Enter edit mode on the most-recently-edited text shape (excluding
   * `excludeId` and the just-edited shape if same). */
  startEditingMostRecent(excludeId?: string): boolean {
    for (let i = this._recentEditIds.length - 1; i >= 0; i--) {
      const id = this._recentEditIds[i];
      if (id === excludeId) continue;
      const shape = this.shapes.find((s) => s.id === id);
      if (shape && shape.type === "text") {
        this.startEditingExistingText(shape);
        return true;
      }
    }
    return false;
  }

  recordRecentEdit(shapeId: string) {
    this._recentEditIds = this._recentEditIds.filter((x) => x !== shapeId);
    this._recentEditIds.push(shapeId);
    if (this._recentEditIds.length > 50) this._recentEditIds.shift();
  }

  /** Re-layout the flowchart subtree rooted at `rootId` via FlowchartLayer.tidy.
   * Root stays anchored; descendants move so siblings don't overlap. */
  tidySubtree(rootId: string): void {
    const layout = this.flowchart.tidy(rootId, this.shapes);
    if (layout.size === 0) return;
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, tl] of layout) {
      const s = this.shapes.find((x) => x.id === id);
      if (!s) continue;
      const old = getShapeBounds(s);
      const dx = tl.minX - old.minX;
      const dy = tl.minY - old.minY;
      if (dx !== 0 || dy !== 0) deltas.set(id, { dx, dy });
    }
    if (deltas.size === 0) return;
    this.shapes = this.shapes.map((s) => {
      const d = deltas.get(s.id);
      return d ? moveShape(s, d.dx, d.dy) : s;
    });
    this.recordHistory();
    this.notify("shapes");
  }

  /** Find the parent shape whose tidy button contains `screenPt`. */
  private _hitTestTidyButton(screenPt: Point): string | null {
    const z = this.camera.zoom;
    for (const s of this.shapes) {
      if (s.type !== "text") continue;
      if (s.pocketed) continue;
      if (this.flowchart.childrenOf(s.id).length === 0) continue;
      const b = getShapeBounds(s);
      const cx = (b.minX + b.maxX) / 2 * z + this.camera.x;
      const cy = b.minY * z + this.camera.y - TIDY_BUTTON_GAP - TIDY_BUTTON_RADIUS;
      if (Math.hypot(screenPt.x - cx, screenPt.y - cy) < TIDY_BUTTON_RADIUS) {
        return s.id;
      }
    }
    return null;
  }

  // === Resize handle hit test ===
  hitTestResizeHandles(canvasPt: Point): { shapeId: string; handle: ResizeHandle } | null {
    const handleRadius = (HANDLE_SIZE / 2) / this.camera.zoom + 2;
    for (const shape of this.shapes) {
      if (!this.selectedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue;
      const b = getShapeBounds(shape);
      const pad = 6;
      const x1 = b.minX - pad, y1 = b.minY - pad;
      const x2 = b.maxX + pad, y2 = b.maxY + pad;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const corners: [number, number, ResizeHandle][] = [
        [x1, y1, "nw"], [x2, y1, "ne"], [x1, y2, "sw"], [x2, y2, "se"],
        [mx, y1, "n"], [mx, y2, "s"], [x1, my, "w"], [x2, my, "e"],
      ];
      for (const [hx, hy, handle] of corners) {
        const dx = canvasPt.x - hx, dy = canvasPt.y - hy;
        if (Math.sqrt(dx * dx + dy * dy) < handleRadius) return { shapeId: shape.id, handle };
      }
    }
    return null;
  }

  // === Pointer handlers ===
  handlePointerDown(e: PointerEvent) {
    const canvas = this.canvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);

    if (e.button === 1) {
      this._isPanningActive = true;
      this._panStart = { x: e.clientX, y: e.clientY };
      this._cameraStart = { ...this.camera };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (this.editingText) {
      this.commitText(this.editingText);
      this.editingText = null;
      this.notify("editingText");
      return; // commit ends the interaction; next click starts fresh
    }

    // Click on the X delete-button of a hovered flowchart edge.
    if (this.flowHoveredEdgeId) {
      const mid = this.flowchart.getEdgeMidpoint(this.flowHoveredEdgeId, this.shapes);
      const r = 12 / this.camera.zoom;
      if (mid && Math.hypot(canvasPt.x - mid.x, canvasPt.y - mid.y) < r) {
        this.flowchart.removeEdge(this.flowHoveredEdgeId);
        this.flowHoveredEdgeId = null;
        this.recordHistory();
        this.notify("shapes");
        return;
      }
    }

    // Click on a tidy button above a parent text shape — runs tidy() on its
    // subtree. Hit-tested in screen space because the button has a fixed
    // pixel size regardless of zoom (drawn in screen space by the renderer).
    const tidyHit = this._hitTestTidyButton(screenPt);
    if (tidyHit) {
      this.tidySubtree(tidyHit);
      return;
    }

    // Text tool no longer creates a shape on single-click (it falls through
    // to select-tool behavior below) — always capture so drag-select works.
    canvas.setPointerCapture(e.pointerId);

    // Exit crop mode when clicking outside the cropping image (unless clicking its handles)
    if (this.croppingImageId) {
      const cropShape = this.shapes.find((s) => s.id === this.croppingImageId);
      const handleHit = this.hitTestResizeHandles(canvasPt);
      if (!handleHit || handleHit.shapeId !== this.croppingImageId) {
        if (!cropShape || !hitTestShape(canvasPt, cropShape)) {
          this.stopCropping();
        }
      }
    }

    if (this.isPanning) {
      this._isPanningActive = true;
      this._panStart = { x: e.clientX, y: e.clientY };
      this._cameraStart = { ...this.camera };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (this.tool === "text" && !this.brainstormMode) {
      // Single click on the canvas drops back into the select tool. Text
      // creation is handled by handleDoubleClick — that way a stray click
      // never accidentally creates an empty text shape.
      this.tool = "select";
      this.notify("tool");
    }

    if (this.brainstormMode) {
      // Brainstorm mode — handled by brainstorm-input.ts widget, just skip
    } else if (this.tool === "select") {
      const handleHit = this.hitTestResizeHandles(canvasPt);
      if (handleHit) {
        this._isResizing = true;
        this._resizeHandle = handleHit.handle;
        this._resizeStart = canvasPt;
        const shape = this.shapes.find((s) => s.id === handleHit.shapeId);
        if (shape) {
          this._resizeOrigShape = structuredClone(shape);
          this._resizeOrigBounds = { ...getShapeBounds(shape) };
        }
        return;
      }

      // Check pocketed shapes first (screen-space hit test)
      const pocketHit = findPocketedShapeAtScreen(screenPt, this.shapes, canvas.clientWidth, this.fontFamily);
      if (pocketHit) {
        const next = e.shiftKey ? new Set(this.selectedIds) : new Set<string>();
        const allSel = e.shiftKey && pocketHit.every((id) => next.has(id));
        pocketHit.forEach((id) => allSel ? next.delete(id) : next.add(id));
        this.selectedIds = next;
        this.notify("selectedIds");
        // Prepare for drag-from-pocket
        this._pocketDragPending = true;
        this._pocketDragScreenStart = screenPt;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const { pocketedIds } = computePocketLayout(this.shapes, canvas.clientWidth, this.fontFamily);
      const hitShape = findShapeAtPoint(canvasPt, this.shapes.filter((s) => !pocketedIds.has(s.id)));

      // Cmd+click on a link: open in browser/app
      if (hitShape && hitShape.type === "text" && (e.metaKey || e.ctrlKey)) {
        const link = hitTestLink(canvasPt, hitShape);
        if (link) { openExternalUrl(link); return; }
      }

      if (hitShape) {
        const groupMembers = hitShape.groupId
          ? this.shapes.filter((s) => s.groupId === hitShape.groupId).map((s) => s.id)
          : [hitShape.id];

        if (e.shiftKey) {
          const next = new Set(this.selectedIds);
          const allSelected = groupMembers.every((id) => next.has(id));
          groupMembers.forEach((id) => allSelected ? next.delete(id) : next.add(id));
          this.selectedIds = next;
          this.notify("selectedIds");
        } else {
          if (!this.selectedIds.has(hitShape.id)) {
            this.selectedIds = new Set(groupMembers);
            this.notify("selectedIds");
          }
          this._isDragging = true;
          this._dragStart = canvasPt;
          this._startDragHoldTimer();

          if (e.altKey) {
            const currentSelected = this.selectedIds.has(hitShape.id) ? this.selectedIds : new Set(groupMembers);
            const clones: Shape[] = [];
            const groupIdMap = new Map<string, string>();
            for (const s of this.shapes) {
              if (!currentSelected.has(s.id)) continue;
              const clone = { ...structuredClone(s), id: generateId() };
              if (clone.groupId) {
                if (!groupIdMap.has(clone.groupId)) groupIdMap.set(clone.groupId, generateId());
                clone.groupId = groupIdMap.get(clone.groupId);
              }
              clones.push(clone);
            }
            this.shapes = [...this.shapes, ...clones];
            this.selectedIds = new Set(clones.map((c) => c.id));
            this.notify("shapes");
            this.notify("selectedIds");
          }
        }
      } else {
        if (!e.shiftKey) { this.selectedIds = new Set(); this.notify("selectedIds"); }
        this._selectStart = canvasPt;
        this.selectionBox = { start: canvasPt, end: canvasPt };
        this.notify("selectionBox");
      }
    } else if (this.tool === "drag-area") {
      this.creatingDragArea = { start: canvasPt, end: canvasPt };
      this.notify("creatingDragArea");
    }
  }

  handleDoubleClick(e: MouseEvent) {
    if (!this.canvasEl || this.brainstormMode) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);
    const hit = findShapeAtPoint(canvasPt, this.shapes);
    if (hit && hit.type === "text") {
      this.startEditingExistingText(hit);
    } else {
      this.editingText = { shapeId: null, position: canvasPt, text: "", fontSize: this.fontSize, color: this.color, width: 350 };
      this.notify("editingText");
    }
  }

  handlePointerMove(e: PointerEvent) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);

    if (this._isPanningActive) {
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      this.camera = { x: this._cameraStart.x + dx, y: this._cameraStart.y + dy, zoom: this._cameraStart.zoom };
      this.notify("camera");
      return;
    }

    // Drag from pocket: on first movement, unpocket shapes and place at cursor
    if (this._pocketDragPending && this.selectedIds.size > 0) {
      const dx = screenPt.x - this._pocketDragScreenStart.x;
      const dy = screenPt.y - this._pocketDragScreenStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        // Compute bounding box of selected shapes to center them on cursor
        let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
        for (const s of this.shapes) {
          if (!this.selectedIds.has(s.id)) continue;
          const b = getShapeBounds(s);
          gMinX = Math.min(gMinX, b.minX); gMinY = Math.min(gMinY, b.minY);
          gMaxX = Math.max(gMaxX, b.maxX); gMaxY = Math.max(gMaxY, b.maxY);
        }
        const offsetX = canvasPt.x - (gMinX + gMaxX) / 2;
        const offsetY = canvasPt.y - (gMinY + gMaxY) / 2;
        this.shapes = this.shapes.map((s) => {
          if (!this.selectedIds.has(s.id)) return s;
          return moveShape({ ...s, pocketed: undefined }, offsetX, offsetY);
        });
        this._pocketDragPending = false;
        this._isDragging = true;
        this._dragStart = canvasPt;
        this.notify("shapes");
      }
      return;
    }

    if (this._isDragging && this.tool === "select") {
      const dx = canvasPt.x - this._dragStart.x;
      const dy = canvasPt.y - this._dragStart.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        this._dragStart = canvasPt;

        // In crop mode: drag shifts the crop window within the image
        if (this.croppingImageId && this.selectedIds.has(this.croppingImageId)) {
          this.shapes = this.shapes.map((s) => {
            if (s.id !== this.croppingImageId || s.type !== "image") return s;
            const crop = s.crop || { x: 0, y: 0, w: 1, h: 1 };
            // Convert canvas-space dx/dy to crop-fraction deltas
            const fracDx = -(dx / s.width) * crop.w;
            const fracDy = -(dy / s.height) * crop.h;
            let nx = crop.x + fracDx, ny = crop.y + fracDy;
            // Clamp so crop stays within 0..1-w and 0..1-h
            nx = Math.max(0, Math.min(1 - crop.w, nx));
            ny = Math.max(0, Math.min(1 - crop.h, ny));
            return { ...s, crop: { ...crop, x: nx, y: ny } };
          });
          this.notify("shapes");
          return;
        }

        const selectedDragAreaIds = new Set<string>();
        for (const s of this.shapes) {
          if (this.selectedIds.has(s.id) && s.type === "drag-area") selectedDragAreaIds.add(s.id);
        }
        // Flowchart descendants of any selected node move with the selection,
        // preserving the downstream spatial layout.
        const flowDescendants = new Set<string>();
        for (const id of this.selectedIds) {
          for (const d of this.flowchart.descendantsOf(id)) flowDescendants.add(d);
        }
        this.shapes = this.shapes.map((s) => {
          if (this.selectedIds.has(s.id)) return moveShape(s, dx, dy);
          if (s.parentId && selectedDragAreaIds.has(s.parentId)) return moveShape(s, dx, dy);
          if (flowDescendants.has(s.id)) return moveShape(s, dx, dy);
          return s;
        });
        // While dragging text shapes, keep the hover drop target up to date
        // so the renderer can outline it. Uses the live cursor position so
        // the target highlight matches what the user sees regardless of how
        // many shapes are being dragged.
        const draggedTextIds = new Set<string>();
        for (const id of this.selectedIds) {
          const s = this.shapes.find((s) => s.id === id);
          if (s && s.type === "text") draggedTextIds.add(id);
        }
        if (draggedTextIds.size > 0) {
          let hoverId: string | null = null;
          for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            if (draggedTextIds.has(s.id)) continue;
            if (s.type !== "text") continue;
            const b = getShapeBounds(s);
            if (
              canvasPt.x >= b.minX &&
              canvasPt.x <= b.maxX &&
              canvasPt.y >= b.minY &&
              canvasPt.y <= b.maxY
            ) {
              hoverId = s.id;
              break;
            }
          }
          if (hoverId !== this.flowDropTargetId) {
            this.flowDropTargetId = hoverId;
          }
        }
        this.notify("shapes");
      }
      return;
    }

    if (this._isResizing && this._resizeOrigShape && this._resizeOrigBounds) {
      const dx = canvasPt.x - this._resizeStart.x;
      const dy = canvasPt.y - this._resizeStart.y;
      const handle = this._resizeHandle!;
      const origShape = this._resizeOrigShape;
      const orig = this._resizeOrigBounds;
      if (this.croppingImageId === origShape.id && origShape.type === "image") {
        this.shapes = this.shapes.map((s) => s.id !== origShape.id ? s : applyCropResize(origShape, handle, orig, dx, dy));
      } else {
        this.shapes = this.shapes.map((s) => s.id !== origShape.id ? s : applyResize(origShape, handle, orig, dx, dy));
      }
      this.notify("shapes");
      return;
    }

    if (this.tool === "select" && this._selectStart) {
      this.selectionBox = { start: this._selectStart, end: canvasPt };
      this.notify("selectionBox");
    } else if (this.tool === "drag-area" && this.creatingDragArea) {
      this.creatingDragArea = { ...this.creatingDragArea, end: canvasPt };
      this.notify("creatingDragArea");
    } else {
      // Idle hover: track flowchart edge under cursor for the delete button.
      const threshold = 10 / this.camera.zoom;
      const edge = this.flowchart.findEdgeNear(canvasPt, this.shapes, threshold);
      const newId = edge ? edge.id : null;
      if (newId !== this.flowHoveredEdgeId) {
        this.flowHoveredEdgeId = newId;
        this.notify("shapes"); // triggers re-render
      }
    }
  }

  handlePointerUp(e: PointerEvent) {
    if (this._isPanningActive) { this._isPanningActive = false; return; }

    // Pocket drag pending: click without movement — just select, no move
    if (this._pocketDragPending) {
      this._pocketDragPending = false;
      return;
    }

    if (this._isDragging) {
      this._isDragging = false;
      const trayWasVisible = this._showPocketTray;
      this._clearDragHoldTimer();

      // Check if items should be pocketed (dropped in pocket zone on left edge)
      // Only if tray was visible (held for 1+ second)
      const canvas = this.canvasEl;
      if (trayWasVisible && canvas) {
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        if (screenX < POCKET_ZONE_WIDTH) {
          this.shapes = this.shapes.map((s) =>
            this.selectedIds.has(s.id) ? { ...s, pocketed: true } : s,
          );
          this.selectedIds = new Set();
          this.recordHistory();
          this.notify("shapes");
          this.notify("selectedIds");
          return;
        }
      }

      const dragAreas = this.shapes.filter((s) => s.type === "drag-area");
      this.shapes = this.shapes.map((s) => {
        if (!this.selectedIds.has(s.id)) return s;
        if (s.type === "drag-area") return s;
        const bounds = getShapeBounds(s);
        const center: Point = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        let newParent: string | undefined;
        for (const da of dragAreas) {
          if (this.selectedIds.has(da.id)) continue;
          if (pointInBounds(center, getShapeBounds(da), 0)) { newParent = da.id; break; }
        }
        if (newParent !== s.parentId) return { ...s, parentId: newParent };
        return s;
      });

      // Flowchart drop: any number of dragged text shapes dropped on top of
      // another text shape. Behavior depends on the modifier:
      //   - default            → each dropped shape becomes a child of the
      //                          target (parent → child arrow, stacked below
      //                          existing siblings)
      //   - cmd / ctrl held    → each dropped shape's text is APPENDED to
      //                          the target's text and the dropped shape is
      //                          deleted (no arrow drawn)
      // The target is found via the live cursor position at drop time, not
      // the centroid — works the same for one or many dragged shapes.
      const droppedTextIds: string[] = [];
      for (const s of this.shapes) {
        if (this.selectedIds.has(s.id) && s.type === "text") {
          droppedTextIds.push(s.id);
        }
      }
      if (droppedTextIds.length > 0) {
        const droppedSet = new Set(droppedTextIds);
        let dropPt: Point | null = null;
        if (this.canvasEl) {
          const r = this.canvasEl.getBoundingClientRect();
          dropPt = screenToCanvas({ x: e.clientX - r.left, y: e.clientY - r.top }, this.camera);
        }

        let target: Shape | null = null;
        if (dropPt) {
          for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            if (droppedSet.has(s.id)) continue;
            if (s.type !== "text") continue;
            const b = getShapeBounds(s);
            if (
              dropPt.x >= b.minX &&
              dropPt.x <= b.maxX &&
              dropPt.y >= b.minY &&
              dropPt.y <= b.maxY
            ) {
              target = s;
              break;
            }
          }
        }

        if (target) {
          const appendMode = e.metaKey || e.ctrlKey;
          if (appendMode) {
            // Concatenate dropped texts in stack order and merge into target.
            const targetId = target.id;
            const appended: string[] = [];
            for (const id of droppedTextIds) {
              const s = this.shapes.find((sh) => sh.id === id);
              if (s && s.type === "text") appended.push(s.text);
            }
            const merged = appended.join("\n\n");
            this.shapes = this.shapes
              .filter((s) => !droppedSet.has(s.id))
              .map((s) => {
                if (s.id !== targetId || s.type !== "text") return s;
                const nextText = s.text ? `${s.text}\n\n${merged}` : merged;
                const updated = { ...s, text: nextText };
                if (!s.manualWidth) {
                  updated.width = autoFitWidth(nextText, s.fontSize, s.width, this.fontFamily);
                }
                return updated;
              });
            for (const id of droppedTextIds) this.flowchart.removeNode(id);
            this.selectedIds = new Set([targetId]);
            this.notify("selectedIds");
          } else {
            for (const droppedId of droppedTextIds) {
              const dropped = this.shapes.find((s) => s.id === droppedId);
              if (!dropped || dropped.type !== "text") continue;
              const oldBounds = getShapeBounds(dropped);
              const newTL = this.flowchart.tryConnect(droppedId, target.id, this.shapes);
              if (!newTL) continue;
              const dx = newTL.minX - oldBounds.minX;
              const dy = newTL.minY - oldBounds.minY;
              this.shapes = this.shapes.map((s) =>
                s.id === droppedId && s.type === "text"
                  ? { ...s, position: { x: s.position.x + dx, y: s.position.y + dy } }
                  : s,
              );
              // Snapping the parent also pulls its descendants — replay their
              // existing offset so the chain stays intact.
              const desc = this.flowchart.descendantsOf(droppedId);
              if (desc.size > 0) {
                this.shapes = this.shapes.map((s) =>
                  desc.has(s.id) ? moveShape(s, dx, dy) : s,
                );
              }
            }
          }
        }
      }
      this.flowDropTargetId = null;

      this.recordHistory();
      this.notify("shapes");
      return;
    }

    if (this._isResizing) {
      this._isResizing = false;
      this._resizeHandle = null;
      this._resizeOrigShape = null;
      this._resizeOrigBounds = null;
      this.recordHistory();
      return;
    }

    if (this.tool === "select" && this.selectionBox) {
      const box = normalizeBox(this.selectionBox);
      const hits = this.shapes.filter((s) => boundsOverlap(getShapeBounds(s), box));
      if (e.shiftKey) {
        const next = new Set(this.selectedIds);
        hits.forEach((s) => next.add(s.id));
        this.selectedIds = next;
      } else if (hits.length > 0) {
        this.selectedIds = new Set(hits.map((s) => s.id));
      }
      this.selectionBox = null;
      this._selectStart = null;
      this.notify("selectedIds");
      this.notify("selectionBox");
    } else if (this.tool === "drag-area" && this.creatingDragArea) {
      const { start, end } = this.creatingDragArea;
      const minX = Math.min(start.x, end.x), minY = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      if (w > 20 && h > 20) {
        const newArea: DragAreaShape = {
          id: generateId(), type: "drag-area", position: { x: minX, y: minY },
          width: w, height: h, color: "#6b7280", strokeColor: "#6b7280",
          backgroundColor: "rgba(107, 114, 128, 0.16)", borderRadius: 12,
        };
        const areaBounds = getShapeBounds(newArea);
        this.shapes = [...this.shapes.map((s) => {
          if (s.type === "drag-area" || s.parentId) return s;
          if (boundsOverlap(getShapeBounds(s), areaBounds)) return { ...s, parentId: newArea.id };
          return s;
        }), newArea];
        this.tool = "select";
        this.recordHistory();
        this.notify("tool");
      }
      this.creatingDragArea = null;
      this.notify("shapes");
      this.notify("creatingDragArea");
    }
  }

  handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left, mouseY = e.clientY - rect.top;
    const zoomFactor = e.ctrlKey ? 0.01 : 0.001;
    const delta = -e.deltaY * zoomFactor;
    const newZoom = Math.min(2, Math.max(0.1, this.camera.zoom * (1 + delta)));
    const scale = newZoom / this.camera.zoom;
    this.camera = {
      x: mouseX - scale * (mouseX - this.camera.x),
      y: mouseY - scale * (mouseY - this.camera.y),
      zoom: newZoom,
    };
    this.notify("camera");
  }

  // === Pocket hold timer ===
  private _startDragHoldTimer() {
    this._clearDragHoldTimer();
    this._dragHoldTimer = setTimeout(() => {
      this._showPocketTray = true;
      this.notify("shapes"); // triggers render to show tray
    }, 1000);
  }

  private _clearDragHoldTimer() {
    if (this._dragHoldTimer !== null) {
      clearTimeout(this._dragHoldTimer);
      this._dragHoldTimer = null;
    }
    this._showPocketTray = false;
  }

  // === Shape operations ===
  deleteSelected() {
    if (this.selectedIds.size === 0) return;
    const deletingIds = new Set(this.selectedIds);
    this.shapes = this.shapes
      .filter((s) => !deletingIds.has(s.id))
      .map((s) => s.parentId && deletingIds.has(s.parentId) ? { ...s, parentId: undefined } : s);
    for (const id of deletingIds) this.flowchart.removeNode(id);
    this.selectedIds = new Set();
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  groupSelected() {
    if (this.selectedIds.size < 2) return;
    const gid = generateId();
    this.shapes = this.shapes.map((s) => this.selectedIds.has(s.id) ? { ...s, groupId: gid } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  ungroupSelected() {
    this.shapes = this.shapes.map((s) => this.selectedIds.has(s.id) ? { ...s, groupId: undefined } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  changeSelectedColor(colorName: string) {
    const hex = COLOR_PALETTE[colorName] || colorName;
    this.shapes = this.shapes.map((s) => this.selectedIds.has(s.id) ? { ...s, color: hex } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  changeSelectedBackground(colorName: string) {
    this.shapes = this.shapes.map((s) => {
      if (!this.selectedIds.has(s.id)) return s;
      if (s.type === "text") return { ...s, backgroundColor: colorName === "reset" ? undefined : colorName };
      if (s.type === "drag-area") {
        if (colorName === "reset") return { ...s, strokeColor: "#6b7280", backgroundColor: "rgba(107, 114, 128, 0.16)" };
        const hex = COLOR_PALETTE[colorName] || "#6b7280";
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return { ...s, strokeColor: hex, backgroundColor: `rgba(${r}, ${g}, ${b}, 0.16)` };
      }
      return s;
    });
    this.recordHistory();
    this.notify("shapes");
  }

  /**
   * Apply both foreground and background color to all selected text shapes.
   * Used by the term-style presets (Concept/Name/Book/Definition) to give a
   * canvas note the same look as a highlighted chip in the chat panel, plus
   * a "No style" entry that clears the background (pass undefined).
   * Hex strings bypass the palette so the term colors don't have to be
   * registered as named entries.
   */
  applyTextStyle(fg: string, bg: string | undefined) {
    this.shapes = this.shapes.map((s) => {
      if (!this.selectedIds.has(s.id)) return s;
      if (s.type !== "text") return s;
      return { ...s, color: fg, backgroundColor: bg };
    });
    this.recordHistory();
    this.notify("shapes");
  }

  startCropping(shapeId: string) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape || shape.type !== "image") return;
    if (!shape.crop) {
      this.shapes = this.shapes.map((s) => s.id === shapeId ? { ...s, crop: { x: 0, y: 0, w: 1, h: 1 } } : s);
      this.notify("shapes");
    }
    this.croppingImageId = shapeId;
    this.notify("selectedIds");
  }

  stopCropping() {
    if (!this.croppingImageId) return;
    this.croppingImageId = null;
    this.recordHistory();
    this.notify("selectedIds");
  }

  applyCrop(shapeId: string, crop: { x: number; y: number; w: number; h: number }) {
    this.shapes = this.shapes.map((s) => s.id === shapeId && s.type === "image" ? { ...s, crop } : s);
    this.notify("shapes");
  }

  changeSelectedFontSize(newSize: number) {
    this.shapes = this.shapes.map((s) =>
      this.selectedIds.has(s.id) && s.type === "text" ? { ...s, fontSize: newSize } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  unpocketSelected() {
    const ids = new Set<string>();
    for (const s of this.shapes) {
      if (!this.selectedIds.has(s.id)) continue;
      ids.add(s.id);
      if (s.groupId) this.shapes.forEach((gs) => { if (gs.groupId === s.groupId) ids.add(gs.id); });
    }
    this.shapes = this.shapes.map((s) => ids.has(s.id) ? { ...s, pocketed: undefined } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  alignSelected(direction: "left" | "center" | "right" | "top" | "middle" | "bottom") {
    const selected = this.shapes.filter((s) => this.selectedIds.has(s.id));
    if (selected.length < 2) return;
    const aligned = alignShapes(selected, direction);
    const map = new Map(aligned.map((s) => [s.id, s]));
    this.shapes = this.shapes.map((s) => map.get(s.id) || s);
    this.recordHistory();
    this.notify("shapes");
  }

  distributeSelected(axis: "horizontal" | "vertical") {
    const selected = this.shapes.filter((s) => this.selectedIds.has(s.id));
    if (selected.length < 3) return;
    const distributed = distributeShapes(selected, axis);
    const map = new Map(distributed.map((s) => [s.id, s]));
    this.shapes = this.shapes.map((s) => map.get(s.id) || s);
    this.recordHistory();
    this.notify("shapes");
  }

  // === Bookmarks ===
  addBookmark(name: string) { this.bookmarks = [...this.bookmarks, { id: generateId(), name, camera: { ...this.camera } }]; this.notify("bookmarks"); }
  goToBookmark(bm: CameraBookmark) { this.camera = { ...bm.camera }; this.notify("camera"); }
  updateBookmark(id: string) { this.bookmarks = this.bookmarks.map((b) => b.id === id ? { ...b, camera: { ...this.camera } } : b); this.notify("bookmarks"); }
  deleteBookmark(id: string) { this.bookmarks = this.bookmarks.filter((b) => b.id !== id); this.notify("bookmarks"); }

  renameImage(id: string, name: string) {
    this.shapes = this.shapes.map((s) => s.id === id && s.type === "image" ? { ...s, name } : s);
    this.notify("shapes");
  }

  // === External content ===
  addImageShape(dataUrl: string, name: string, w: number, h: number, position?: Point) {
    const maxSize = 400, aspect = w / Math.max(h, 1);
    let dw: number, dh: number;
    if (w >= h) { dw = Math.min(maxSize, w); dh = dw / aspect; }
    else { dh = Math.min(maxSize, h); dw = dh * aspect; }
    const pos = position || screenToCanvas({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, this.camera);
    const id = generateId();
    this.shapes = [...this.shapes, {
      id, type: "image", position: { x: pos.x - dw / 2, y: pos.y - dh / 2 },
      width: dw, height: dh, dataUrl, name, color: "#000000",
    } as ImageShape];
    this.selectedIds = new Set([id]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
  }

  addTextShapeAtCenter(text: string) {
    this.addTextShapeAtPosition(text, screenToCanvas({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, this.camera));
  }

  addTextShapeAtPosition(text: string, position: Point, opts: { record?: boolean } = {}) {
    this.shapes = [...this.shapes, { id: generateId(), type: "text", position, text, fontSize: 18, color: "#000000", width: 350 } as TextShape];
    if (opts.record !== false) this.recordHistory();
    this.notify("shapes");
  }

  focusShape(shapeId: string) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const bounds = getShapeBounds(shape);
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    // Use the actual canvas element's dimensions so focus accounts for the
    // sidebar (canvas !== window when the layout has chrome on the right).
    const w = this.canvasEl?.clientWidth ?? window.innerWidth;
    const hgt = this.canvasEl?.clientHeight ?? window.innerHeight;
    this.camera = {
      x: w / 2 - cx * this.camera.zoom,
      y: hgt / 2 - cy * this.camera.zoom,
      zoom: this.camera.zoom,
    };
    this.selectedIds = new Set([shapeId]);
    this.notify("camera");
    this.notify("selectedIds");
  }

  moveSelectedToShelf(): string[] {
    const texts = this.shapes.filter((s) => this.selectedIds.has(s.id) && s.type === "text").map((s) => s.type === "text" ? s.text : "");
    this.shapes = this.shapes.filter((s) => !(this.selectedIds.has(s.id) && s.type === "text"));
    this.selectedIds = new Set();
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    return texts;
  }
}
