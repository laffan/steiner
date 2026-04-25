/** Helper functions for state operations (split from state.ts for file size). */

/** Open a URL using Tauri's opener plugin (desktop) or window.open (web fallback). */
export async function openExternalUrl(url: string) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}
import type { ImageShape, Point, SelectionBox, Shape, TextShape } from "./types";
import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "./types";
import { computePocketLayout, getMeasureCtx, hitTestShape, pointInBounds } from "./utils";
import { parseLine, parseText } from "./markdown";
import type { ResizeHandle } from "./state";

export function findShapeAtPoint(pt: Point, shapes: Shape[]): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].type === "drag-area") continue;
    if (hitTestShape(pt, shapes[i])) return shapes[i];
  }
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].type === "drag-area" && hitTestShape(pt, shapes[i])) return shapes[i];
  }
  return null;
}

/** Hit-test a point against link runs in a text shape. Returns the URL or null. */
export function hitTestLink(pt: Point, shape: TextShape): string | null {
  const fs = shape.fontSize;
  const measure = (t: string, s: number) => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `${s}px ${FONT_FAMILY}`;
    return c.measureText(t).width;
  };
  const lines = parseText(shape.text, shape.width && shape.width > 0 ? shape.width : undefined, fs, measure);
  let y = shape.position.y;
  for (const line of lines) {
    const lfs = fs * line.sizeScale;
    const lh = lfs * LINE_HEIGHT_RATIO;
    let x = shape.position.x;
    for (const run of line.runs) {
      const w = measure(run.text, lfs);
      if (run.link && pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + lh) return run.link;
      x += w;
    }
    y += lh;
  }
  return null;
}

export function normalizeBox(box: SelectionBox) {
  return { minX: Math.min(box.start.x, box.end.x), minY: Math.min(box.start.y, box.end.y), maxX: Math.max(box.start.x, box.end.x), maxY: Math.max(box.start.y, box.end.y) };
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.type) {
    case "draw": return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "text": case "image": case "drag-area":
      return { ...shape, position: { x: shape.position.x + dx, y: shape.position.y + dy } };
  }
}

export function applyResize(origShape: Shape, handle: ResizeHandle, orig: { minX: number; minY: number; maxX: number; maxY: number }, dx: number, dy: number): Shape {
  let minX = orig.minX, minY = orig.minY, maxX = orig.maxX, maxY = orig.maxY;
  if (handle.includes("w")) minX += dx;
  if (handle.includes("e")) maxX += dx;
  if (handle.includes("n")) minY += dy;
  if (handle.includes("s")) maxY += dy;
  const MIN = 30;
  if (maxX - minX < MIN) { if (handle.includes("w")) minX = maxX - MIN; else maxX = minX + MIN; }
  if (maxY - minY < MIN) { if (handle.includes("n")) minY = maxY - MIN; else maxY = minY + MIN; }
  const newW = maxX - minX, newH = maxY - minY;
  switch (origShape.type) {
    case "text": return { ...origShape, position: { x: minX, y: minY }, width: Math.max(MIN, newW), manualWidth: true };
    case "image": {
      const origW = orig.maxX - orig.minX;
      const origH = orig.maxY - orig.minY;
      const aspect = origW / (origH || 1);
      if (handle === "n" || handle === "s") {
        const newW2 = newH * aspect;
        const cx = (minX + maxX) / 2;
        minX = cx - newW2 / 2;
        maxX = cx + newW2 / 2;
      } else if (handle === "e" || handle === "w") {
        const newH2 = newW / aspect;
        const cy = (minY + maxY) / 2;
        minY = cy - newH2 / 2;
        maxY = cy + newH2 / 2;
      } else {
        const scaleX = (maxX - minX) / origW;
        const scaleY = (maxY - minY) / origH;
        const scale = Math.max(scaleX, scaleY);
        const finalW = origW * scale;
        const finalH = origH * scale;
        if (handle.includes("e")) maxX = minX + finalW; else minX = maxX - finalW;
        if (handle.includes("s")) maxY = minY + finalH; else minY = maxY - finalH;
      }
      return { ...origShape, position: { x: minX, y: minY }, width: maxX - minX, height: maxY - minY };
    }
    case "drag-area": return { ...origShape, position: { x: minX, y: minY }, width: newW, height: newH };
    case "draw": {
      const ow = orig.maxX - orig.minX || 1, oh = orig.maxY - orig.minY || 1;
      return { ...origShape, points: origShape.points.map((p) => ({ x: minX + ((p.x - orig.minX) / ow) * newW, y: minY + ((p.y - orig.minY) / oh) * newH })) };
    }
  }
}

export function applyCropResize(origShape: ImageShape, handle: ResizeHandle, orig: { minX: number; minY: number; maxX: number; maxY: number }, dx: number, dy: number): ImageShape {
  let minX = orig.minX, minY = orig.minY, maxX = orig.maxX, maxY = orig.maxY;
  if (handle.includes("w")) minX += dx;
  if (handle.includes("e")) maxX += dx;
  if (handle.includes("n")) minY += dy;
  if (handle.includes("s")) maxY += dy;
  minX = Math.max(minX, orig.minX);
  minY = Math.max(minY, orig.minY);
  maxX = Math.min(maxX, orig.maxX);
  maxY = Math.min(maxY, orig.maxY);
  const MIN = 20;
  if (maxX - minX < MIN) { if (handle.includes("w")) minX = maxX - MIN; else maxX = minX + MIN; }
  if (maxY - minY < MIN) { if (handle.includes("n")) minY = maxY - MIN; else maxY = minY + MIN; }
  const origW = orig.maxX - orig.minX, origH = orig.maxY - orig.minY;
  const oldCrop = origShape.crop || { x: 0, y: 0, w: 1, h: 1 };
  const cropX = oldCrop.x + ((minX - orig.minX) / origW) * oldCrop.w;
  const cropY = oldCrop.y + ((minY - orig.minY) / origH) * oldCrop.h;
  const cropW = ((maxX - minX) / origW) * oldCrop.w;
  const cropH = ((maxY - minY) / origH) * oldCrop.h;
  return { ...origShape, position: { x: minX, y: minY }, width: maxX - minX, height: maxY - minY, crop: { x: cropX, y: cropY, w: cropW, h: cropH } };
}

/** Measure widest rendered line (accounting for heading scale, bold/italic + font) and return fitted width. */
export function autoFitWidth(text: string, fontSize: number, constraintWidth: number | undefined, fontFamily: string): number {
  const cw = constraintWidth || 350;
  const ff = `${fontFamily}, ${FONT_FAMILY}`;
  const ctx = getMeasureCtx();
  let maxW = 0;
  for (const line of text.split("\n")) {
    const parsed = parseLine(line);
    const lineFontSize = fontSize * parsed.sizeScale;
    let lineW = 0;
    for (const run of parsed.runs) {
      const weight = run.bold ? "bold" : "normal";
      const style = run.italic ? "italic" : "normal";
      ctx.font = `${style} ${weight} ${lineFontSize}px ${ff}`;
      lineW += ctx.measureText(run.text).width;
    }
    maxW = Math.max(maxW, lineW);
  }
  return maxW < cw ? Math.max(30, maxW + 8) : cw;
}

/** Hit-test screen point against pocketed shapes (rendered in screen space). Returns shape IDs if hit. */
export function findPocketedShapeAtScreen(screenPt: Point, shapes: Shape[], canvasWidth: number, fontFamily?: string): string[] | null {
  const layout = computePocketLayout(shapes, canvasWidth, fontFamily);
  for (const entry of layout.entries) {
    if (pointInBounds(screenPt, entry.screenBounds, 6)) {
      return entry.shapes.map((s) => s.id);
    }
  }
  return null;
}
