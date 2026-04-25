import { LINE_HEIGHT_RATIO, FONT_FAMILY, COLOR_PALETTE } from "./types";
import type { Bounds, Camera, DragAreaShape, Point, Shape } from "./types";
import { parseText } from "./markdown";

let nextId = 0;
export function generateId(): string {
  return `shape_${Date.now()}_${nextId++}`;
}

export function screenToCanvas(screenPoint: Point, camera: Camera): Point {
  return {
    x: (screenPoint.x - camera.x) / camera.zoom,
    y: (screenPoint.y - camera.y) / camera.zoom,
  };
}

export function canvasToScreen(canvasPoint: Point, camera: Camera): Point {
  return {
    x: canvasPoint.x * camera.zoom + camera.x,
    y: canvasPoint.y * camera.zoom + camera.y,
  };
}

// === Bounds ===

export function getShapeBounds(shape: Shape, fontFamily?: string): Bounds {
  switch (shape.type) {
    case "draw":
      return getPointsBounds(shape.points);
    case "text":
      return getTextBounds(shape.position, shape.text, shape.fontSize, shape.width, fontFamily);
    case "image":
      return {
        minX: shape.position.x,
        minY: shape.position.y,
        maxX: shape.position.x + shape.width,
        maxY: shape.position.y + shape.height,
      };
    case "drag-area":
      return {
        minX: shape.position.x,
        minY: shape.position.y,
        maxX: shape.position.x + shape.width,
        maxY: shape.position.y + shape.height,
      };
  }
}

export function getPointsBounds(points: Point[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Offscreen canvas for accurate text measurement
let _measureCtx: CanvasRenderingContext2D | null = null;
export function getMeasureCtx(): CanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = document.createElement("canvas");
    _measureCtx = c.getContext("2d")!;
  }
  return _measureCtx;
}

export function measureTextWidth(text: string, fontSize: number, fontFamily?: string): number {
  const ctx = getMeasureCtx();
  ctx.font = `${fontSize}px ${fontFamily ? fontFamily + ", " + FONT_FAMILY : FONT_FAMILY}`;
  return ctx.measureText(text).width;
}

export function getTextBounds(
  position: Point,
  text: string,
  fontSize: number,
  constraintWidth?: number,
  fontFamily?: string,
): Bounds {
  const baseLineHeight = fontSize * LINE_HEIGHT_RATIO;
  const descenderPad = fontSize * 0.25;
  const ff = (fontFamily || "Inter") + ", " + FONT_FAMILY;

  const measure = (t: string, fs: number): number => {
    const ctx = getMeasureCtx();
    ctx.font = `${fs}px ${ff}`;
    return ctx.measureText(t).width;
  };

  // Use parseText (same as renderer) so line counts match exactly
  const parsedLines = parseText(
    text,
    constraintWidth && constraintWidth > 0 ? constraintWidth : undefined,
    fontSize,
    measure,
  );

  let height = 0;
  let maxWidth = 0;
  for (const line of parsedLines) {
    const lineFontSize = fontSize * line.sizeScale;
    height += lineFontSize * LINE_HEIGHT_RATIO;
    const lineText = line.runs.map((r) => r.text).join("");
    maxWidth = Math.max(maxWidth, measure(lineText, lineFontSize));
  }

  const w = constraintWidth && constraintWidth > 0 ? constraintWidth : Math.max(maxWidth, 20);
  return {
    minX: position.x,
    minY: position.y,
    maxX: position.x + w,
    maxY: position.y + Math.max(height + descenderPad, baseLineHeight + descenderPad),
  };
}

/** Word-wrap using accurate canvas text measurement */
export function wrapTextMeasured(text: string, maxWidth: number, fontSize: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) { result.push(""); continue; }
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (measureTextWidth(test, fontSize) > maxWidth && line.length > 0) {
        result.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) result.push(line);
  }
  return result.length > 0 ? result : [""];
}

/** Word-wrap text to fit within a pixel width (approximate, character-based) */
export function wrapText(text: string, maxWidth: number, charWidth: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
  const result: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      result.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (test.length > maxChars && line.length > 0) {
        result.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) result.push(line);
  }

  return result.length > 0 ? result : [""];
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

export function pointInBounds(
  point: Point,
  bounds: Bounds,
  padding = 8
): boolean {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

// === Hit testing ===

export function hitTestShape(point: Point, shape: Shape): boolean {
  if (shape.type === "draw") {
    return distanceToStroke(point, shape.points) < 12;
  }
  return pointInBounds(point, getShapeBounds(shape), 4);
}

export function distanceToStroke(point: Point, points: Point[]): number {
  let minDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distanceToSegment(point, points[i], points[i + 1]);
    if (d < minDist) minDist = d;
  }
  if (points.length === 1) {
    const dx = point.x - points[0].x;
    const dy = point.y - points[0].y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  return minDist;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const ex = p.x - projX;
  const ey = p.y - projY;
  return Math.sqrt(ex * ex + ey * ey);
}

// === Drag area helpers ===

export function findDragAreaAtPoint(
  point: Point,
  shapes: Shape[]
): DragAreaShape | null {
  // Search in reverse (topmost first), only drag areas
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === "drag-area" && pointInBounds(point, getShapeBounds(s), 0)) {
      return s;
    }
  }
  return null;
}

export function getChildrenOfDragArea(
  dragAreaId: string,
  shapes: Shape[]
): Shape[] {
  return shapes.filter((s) => s.parentId === dragAreaId);
}

export function resolveColor(colorName: string): string {
  return COLOR_PALETTE[colorName] || colorName;
}

// === Alignment ===

export function alignShapes(
  shapes: Shape[],
  direction: "left" | "center" | "right" | "top" | "middle" | "bottom"
): Shape[] {
  if (shapes.length < 2) return shapes;
  const allBounds = shapes.map((s) => getShapeBounds(s));

  let target: number;
  switch (direction) {
    case "left":
      target = Math.min(...allBounds.map((b) => b.minX));
      break;
    case "right":
      target = Math.max(...allBounds.map((b) => b.maxX));
      break;
    case "top":
      target = Math.min(...allBounds.map((b) => b.minY));
      break;
    case "bottom":
      target = Math.max(...allBounds.map((b) => b.maxY));
      break;
    case "center":
      target =
        (Math.min(...allBounds.map((b) => b.minX)) +
          Math.max(...allBounds.map((b) => b.maxX))) /
        2;
      break;
    case "middle":
      target =
        (Math.min(...allBounds.map((b) => b.minY)) +
          Math.max(...allBounds.map((b) => b.maxY))) /
        2;
      break;
  }

  return shapes.map((s, i) => {
    const b = allBounds[i];
    const clone = { ...s };
    switch (direction) {
      case "left": {
        const dx = target - b.minX;
        return shiftShape(clone, dx, 0);
      }
      case "right": {
        const dx = target - b.maxX;
        return shiftShape(clone, dx, 0);
      }
      case "center": {
        const cx = (b.minX + b.maxX) / 2;
        return shiftShape(clone, target - cx, 0);
      }
      case "top": {
        const dy = target - b.minY;
        return shiftShape(clone, 0, dy);
      }
      case "bottom": {
        const dy = target - b.maxY;
        return shiftShape(clone, 0, dy);
      }
      case "middle": {
        const cy = (b.minY + b.maxY) / 2;
        return shiftShape(clone, 0, target - cy);
      }
    }
  });
}

export function distributeShapes(
  shapes: Shape[],
  axis: "horizontal" | "vertical",
): Shape[] {
  if (shapes.length < 3) return shapes;
  const allBounds = shapes.map((s, i) => ({ i, b: getShapeBounds(s) }));
  if (axis === "horizontal") {
    allBounds.sort((a, b) => a.b.minX - b.b.minX);
    const totalSpan = allBounds[allBounds.length - 1].b.maxX - allBounds[0].b.minX;
    const totalWidths = allBounds.reduce((sum, a) => sum + (a.b.maxX - a.b.minX), 0);
    const gap = (totalSpan - totalWidths) / (allBounds.length - 1);
    let x = allBounds[0].b.minX;
    const deltas = new Map<number, number>();
    for (const item of allBounds) {
      deltas.set(item.i, x - item.b.minX);
      x += (item.b.maxX - item.b.minX) + gap;
    }
    return shapes.map((s, i) => shiftShape(s, deltas.get(i) || 0, 0));
  } else {
    allBounds.sort((a, b) => a.b.minY - b.b.minY);
    const totalSpan = allBounds[allBounds.length - 1].b.maxY - allBounds[0].b.minY;
    const totalHeights = allBounds.reduce((sum, a) => sum + (a.b.maxY - a.b.minY), 0);
    const gap = (totalSpan - totalHeights) / (allBounds.length - 1);
    let y = allBounds[0].b.minY;
    const deltas = new Map<number, number>();
    for (const item of allBounds) {
      deltas.set(item.i, y - item.b.minY);
      y += (item.b.maxY - item.b.minY) + gap;
    }
    return shapes.map((s, i) => shiftShape(s, 0, deltas.get(i) || 0));
  }
}

function shiftShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.type) {
    case "draw":
      return {
        ...shape,
        points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    case "text":
    case "image":
    case "drag-area":
      return {
        ...shape,
        position: {
          x: shape.position.x + dx,
          y: shape.position.y + dy,
        },
      };
  }
}

// === Pocket ===

/** Width of the pocket drop zone on the left edge of the canvas. */
export const POCKET_ZONE_WIDTH = 80;

/** Width of the visible pocket tray strip on the left edge. */
export const POCKET_TRAY_WIDTH = 20;

export interface PocketEntry {
  shapes: Shape[];
  offsetX: number;
  offsetY: number;
  scale: number;
  screenBounds: Bounds;
}

export interface PocketLayout {
  entries: PocketEntry[];
  pocketedIds: Set<string>;
}

/**
 * Compute screen-space layout for pocketed shapes, stacked vertically on the left.
 * Groups shapes by groupId and includes children of pocketed drag areas.
 */
export function computePocketLayout(allShapes: Shape[], _canvasWidth: number, fontFamily?: string): PocketLayout {
  const pocketed = allShapes.filter((s) => s.pocketed);
  if (pocketed.length === 0) return { entries: [], pocketedIds: new Set() };

  const groups: Shape[][] = [];
  const seen = new Set<string>();

  for (const s of pocketed) {
    if (seen.has(s.id)) continue;
    const group: Shape[] = [];

    if (s.groupId) {
      for (const ps of pocketed) {
        if (ps.groupId === s.groupId && !seen.has(ps.id)) {
          seen.add(ps.id);
          group.push(ps);
        }
      }
    } else {
      seen.add(s.id);
      group.push(s);
    }

    // Include children of pocketed drag areas
    const dragAreaIds = new Set(group.filter((g) => g.type === "drag-area").map((g) => g.id));
    for (const child of allShapes) {
      if (child.parentId && dragAreaIds.has(child.parentId) && !seen.has(child.id)) {
        seen.add(child.id);
        group.push(child);
      }
    }

    groups.push(group);
  }

  const MARGIN_LEFT = 4;
  const MARGIN_TOP = 60;
  const GAP = 16;
  const MAX_SIZE = 140;
  let y = MARGIN_TOP;

  const entries: PocketEntry[] = [];
  const pocketedIds = new Set(seen);

  for (const group of groups) {
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    for (const s of group) {
      const b = getShapeBounds(s, fontFamily);
      gMinX = Math.min(gMinX, b.minX);
      gMinY = Math.min(gMinY, b.minY);
      gMaxX = Math.max(gMaxX, b.maxX);
      gMaxY = Math.max(gMaxY, b.maxY);
    }

    const width = gMaxX - gMinX;
    const height = gMaxY - gMinY;

    const scale = Math.min(1, MAX_SIZE / Math.max(width, height));
    const sw = width * scale;
    const sh = height * scale;

    const x = MARGIN_LEFT;

    entries.push({
      shapes: group,
      offsetX: x - gMinX * scale,
      offsetY: y - gMinY * scale,
      scale,
      screenBounds: { minX: x, minY: y, maxX: x + sw, maxY: y + sh },
    });

    y += sh + GAP;
  }

  return { entries, pocketedIds };
}
