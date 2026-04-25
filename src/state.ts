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
import type { AppearanceMode, CanvasTheme } from "./themes";
import { THEMES, getEffectiveVariant } from "./themes";
import {
  autoFitWidth, findShapeAtPoint, findPocketedShapeAtScreen,
  hitTestLink, normalizeBox, moveShape,
  applyResize, applyCropResize, openExternalUrl,
} from "./state-helpers";
import { computePocketLayout, POCKET_ZONE_WIDTH } from "./utils";

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
  tool: Tool = "text";
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

  /** Record current shapes as an undo checkpoint. Call after completed actions. */
  recordHistory() { this._undo.record(this.shapes); }

  /** Initialize undo history (call after loading shapes). */
  initHistory() { this._undo.init(this.shapes); }

  undo() {
    const snapshot = this._undo.undo();
    if (!snapshot) return;
    this.shapes = snapshot;
    this.selectedIds = new Set();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  redo() {
    const snapshot = this._undo.redo();
    if (!snapshot) return;
    this.shapes = snapshot;
    this.selectedIds = new Set();
    this.notify("shapes");
    this.notify("selectedIds");
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
  commitText(editing: EditingText) {
    const trimmed = editing.text.trim();
    if (!trimmed) return;
    let shapeId: string;
    if (editing.shapeId) {
      shapeId = editing.shapeId;
      this.shapes = this.shapes.map((s) => {
        if (s.id !== editing.shapeId || s.type !== "text") return s;
        const updated = { ...s, text: trimmed };
        // Auto-shrink width to content if not manually resized
        if (!s.manualWidth) {
          updated.width = autoFitWidth(trimmed, s.fontSize, editing.width, this.fontFamily);
        }
        return updated;
      });
    } else {
      shapeId = generateId();
      const fitWidth = autoFitWidth(trimmed, editing.fontSize, editing.width, this.fontFamily);
      this.shapes = [...this.shapes, {
        id: shapeId, type: "text", position: editing.position,
        text: trimmed, fontSize: editing.fontSize, color: editing.color,
        width: fitWidth,
      } as TextShape];
    }
    this.selectedIds = new Set([shapeId]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
  }

  startEditingExistingText(shape: TextShape) {
    this.editingText = {
      shapeId: shape.id, position: shape.position,
      text: shape.text, fontSize: shape.fontSize, color: shape.color,
      // Widen to at least 350 for comfortable editing, unless manually set wider
      width: shape.manualWidth ? shape.width : Math.max(350, shape.width || 0),
    };
    this.notify("editingText");
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

    const willEditText = this.tool === "text" && !this.brainstormMode;
    if (!willEditText) canvas.setPointerCapture(e.pointerId);

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
      // Text tool (not brainstorm — brainstorm has its own input widget)
      const hit = findShapeAtPoint(canvasPt, this.shapes);
      if (hit && hit.type === "text") {
        this.startEditingExistingText(hit);
      } else {
        this.editingText = { shapeId: null, position: canvasPt, text: "", fontSize: this.fontSize, color: this.color, width: 350 };
        this.notify("editingText");
      }
    } else if (this.brainstormMode) {
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
        this.shapes = this.shapes.map((s) => {
          if (this.selectedIds.has(s.id)) return moveShape(s, dx, dy);
          if (s.parentId && selectedDragAreaIds.has(s.parentId)) return moveShape(s, dx, dy);
          return s;
        });
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

  addTextShapeAtPosition(text: string, position: Point) {
    this.shapes = [...this.shapes, { id: generateId(), type: "text", position, text, fontSize: 18, color: "#000000", width: 350 } as TextShape];
    this.recordHistory();
    this.notify("shapes");
  }

  focusShape(shapeId: string) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const bounds = getShapeBounds(shape);
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    this.camera = { x: window.innerWidth / 2 - cx * this.camera.zoom, y: window.innerHeight / 2 - cy * this.camera.zoom, zoom: this.camera.zoom };
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
