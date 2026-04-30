/**
 * Canvas export pipeline.
 *
 * Produces rasters (PNG / JPEG / PDF) or a native JSON snapshot
 * (.steiner) from an open NotesCanvas. The modal in
 * `src/ui/export-modal.ts` collects the options and hands them here.
 *
 * Scope options:
 *   - "visible": current viewport at its current camera
 *   - "all":     fit the bbox of every on-canvas shape, with a margin
 *
 * The raster pipeline:
 *   1. Compute target CSS dimensions + camera for the chosen scope.
 *   2. Allocate an offscreen canvas at dims × scale.
 *   3. Call renderForExport() to paint shapes + (optional) background.
 *   4. Hand back encoded bytes.
 */

import type { jsPDF } from "jspdf";
import type { NotesCanvas } from "./notes-canvas";
import { renderForExport } from "./renderer";
import { getShapeBounds } from "./utils";
import { parseText } from "./markdown";
import { COLOR_PALETTE, LINE_HEIGHT_RATIO } from "./types";
import type { Bounds, Camera, DragAreaShape, DrawShape, ImageShape, Shape, TextShape } from "./types";

export type ExportScope = "visible" | "all";
export type ExportFormat = "steiner" | "png" | "jpg" | "pdf";
export type ExportScale = 1 | 2 | 3;

export interface ExportOptions {
  scope: ExportScope;
  /** All-content margin (CSS px at 1x). Ignored when scope === "visible". */
  margin: number;
  format: ExportFormat;
  scale: ExportScale;
  includeBackground: boolean;
}

export function extensionForFormat(fmt: ExportFormat): string {
  switch (fmt) {
    case "steiner": return "steiner";
    case "png": return "png";
    case "jpg": return "jpg";
    case "pdf": return "pdf";
  }
}

export function mimeForFormat(fmt: ExportFormat): string {
  switch (fmt) {
    case "png": return "image/png";
    case "jpg": return "image/jpeg";
    case "pdf": return "application/pdf";
    case "steiner": return "application/json";
  }
}

export async function exportCanvas(
  canvas: NotesCanvas,
  opts: ExportOptions,
): Promise<Uint8Array> {
  if (opts.format === "steiner") return encodeNative(canvas);
  if (opts.format === "pdf") return exportPdfVector(canvas, opts);

  const raster = rasterizeCanvas(canvas, canvas.getImageCache(), opts);
  if (opts.format === "png") return canvasToBytes(raster, "image/png");
  return canvasToBytes(raster, "image/jpeg", 0.92);
}

// ───────────────────── viewport / camera ─────────────────────
//
// Shared between the raster and PDF pipelines so a "visible window"
// vs. "all content" choice produces identically-framed output.

interface Viewport {
  cssW: number;
  cssH: number;
  camera: Camera;
}

function computeViewport(canvas: NotesCanvas, opts: ExportOptions): Viewport {
  const state = canvas.state;
  const viewport = canvas.container.getBoundingClientRect();

  if (opts.scope === "visible") {
    return {
      cssW: Math.max(1, Math.round(viewport.width)),
      cssH: Math.max(1, Math.round(viewport.height)),
      camera: { ...state.camera },
    };
  }

  const bounds = computeContentBounds(state.shapes);
  const m = Math.max(0, opts.margin | 0);
  if (!bounds) {
    const dim = Math.max(1, m * 2 || 64);
    return { cssW: dim, cssH: dim, camera: { x: m, y: m, zoom: 1 } };
  }
  return {
    cssW: Math.max(1, Math.ceil(bounds.maxX - bounds.minX) + m * 2),
    cssH: Math.max(1, Math.ceil(bounds.maxY - bounds.minY) + m * 2),
    camera: { x: -bounds.minX + m, y: -bounds.minY + m, zoom: 1 },
  };
}

// ───────────────────── raster pipeline ─────────────────────

function rasterizeCanvas(
  canvas: NotesCanvas,
  imageCache: Map<string, HTMLImageElement>,
  opts: ExportOptions,
): HTMLCanvasElement {
  const state = canvas.state;
  const { cssW, cssH, camera } = computeViewport(canvas, opts);

  const scale = opts.scale;
  const out = document.createElement("canvas");
  out.width = cssW * scale;
  out.height = cssH * scale;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D context");

  // A single setTransform(scale, …) means downstream draws can think in
  // CSS pixels — matches the live renderer's mental model.
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  renderForExport(ctx, cssW, cssH, {
    shapes: state.shapes,
    camera,
    imageCache,
    theme: state.theme,
    backgroundPattern: state.backgroundPattern,
    gridSpacing: state.gridSpacing,
    gridOpacity: state.gridOpacity,
    fontFamily: state.fontFamily,
    includeBackground: opts.includeBackground,
    flowchart: state.flowchart,
  });

  return out;
}

function computeContentBounds(shapes: { pocketed?: boolean }[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const s of shapes) {
    if (s.pocketed) continue;
    const b = getShapeBounds(s as never);
    if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX)) continue;
    if (b.maxX - b.minX <= 0 && b.maxY - b.minY <= 0) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
    any = true;
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY };
}

// ───────────────────── encoders ─────────────────────

function encodeNative(canvas: NotesCanvas): Uint8Array {
  const payload = {
    format: "steiner",
    version: 1,
    shapes: canvas.getShapes(),
    flowEdges: canvas.state.flowchart.serialize(),
  };
  const json = JSON.stringify(payload, null, 2);
  return new TextEncoder().encode(json);
}

async function canvasToBytes(c: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, mime, quality));
  if (!blob) throw new Error("Canvas encoding failed for " + mime);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

// ───────────────────── vector PDF pipeline ─────────────────────
//
// Builds a single-page PDF whose text is real (selectable, searchable,
// resolution-independent) instead of wrapping a flat raster. Uses
// jsPDF's built-in Helvetica because embedding Inter would require
// shipping a TrueType subsetter — accept the metric drift in v1.
//
// Coordinate system: jsPDF default origin is top-left, units = pt, so
// 1 page-pt maps to 1 CSS-px and we can reuse computeViewport()'s camera
// transform unchanged.

async function exportPdfVector(canvas: NotesCanvas, opts: ExportOptions): Promise<Uint8Array> {
  // Lazy-load jsPDF — pulls in ~370KB of code and is only needed when
  // the user actually exports a PDF.
  const { jsPDF: JsPdfCtor } = await import("jspdf");

  const state = canvas.state;
  const { cssW, cssH, camera } = computeViewport(canvas, opts);

  const doc = new JsPdfCtor({
    unit: "pt",
    format: [cssW, cssH],
    orientation: cssW >= cssH ? "landscape" : "portrait",
    compress: true,
  });

  // Background fill matches renderForExport: theme colour, no grid.
  // Grids would be many thousands of vector ops on a large canvas with
  // little visual return, so omit them from the vector path.
  if (opts.includeBackground) {
    doc.setFillColor(state.theme.canvasBackground);
    doc.rect(0, 0, cssW, cssH, "F");
  }

  const visible = state.shapes.filter((s) => !s.pocketed);

  // Pass 1: drag-area backgrounds (under everything else).
  for (const shape of visible) {
    if (shape.type === "drag-area") drawPdfDragArea(doc, shape, camera);
  }

  // Pass 2: flowchart arrows (between containers and contents).
  for (const e of state.flowchart.describeEdges(visible)) {
    drawPdfFlowEdge(doc, e, camera);
  }

  // Pass 3: text / image / draw shapes.
  for (const shape of visible) {
    if (shape.type === "drag-area") continue;
    if (shape.type === "text") drawPdfText(doc, shape, state.theme, camera);
    else if (shape.type === "image") drawPdfImage(doc, shape, canvas.getImageCache(), camera);
    else if (shape.type === "draw") drawPdfStroke(doc, shape, camera);
  }

  const ab = doc.output("arraybuffer") as ArrayBuffer;
  return new Uint8Array(ab);
}

function toPageX(x: number, c: Camera): number { return x * c.zoom + c.x; }
function toPageY(y: number, c: Camera): number { return y * c.zoom + c.y; }

function drawPdfDragArea(doc: jsPDF, shape: DragAreaShape, c: Camera) {
  const x = toPageX(shape.position.x, c);
  const y = toPageY(shape.position.y, c);
  const w = shape.width * c.zoom;
  const h = shape.height * c.zoom;
  const r = shape.borderRadius * c.zoom;
  const fill = parseRgba(shape.backgroundColor);
  if (fill) doc.setFillColor(fill.r, fill.g, fill.b);
  doc.setDrawColor(shape.strokeColor);
  doc.setLineWidth(2);
  doc.setLineDashPattern([8, 4], 0);
  doc.roundedRect(x, y, w, h, r, r, fill ? "FD" : "S");
  doc.setLineDashPattern([], 0);
}

function drawPdfFlowEdge(
  doc: jsPDF,
  e: { p0: { x: number; y: number }; cp1: { x: number; y: number }; cp2: { x: number; y: number };
       p3: { x: number; y: number }; tip: { x: number; y: number }; sign: number;
       color: string; width: number; arrowHeadSize: number },
  c: Camera,
) {
  doc.setDrawColor(e.color);
  doc.setFillColor(e.color);
  doc.setLineWidth(e.width * c.zoom);
  doc.setLineCap("round");
  doc.setLineJoin("round");

  // Bezier from p0 to p3 — jsPDF's `lines` takes deltas relative to the
  // start, with each control segment as [dx1, dy1, dx2, dy2, dx, dy].
  const p0x = toPageX(e.p0.x, c), p0y = toPageY(e.p0.y, c);
  const cp1x = toPageX(e.cp1.x, c), cp1y = toPageY(e.cp1.y, c);
  const cp2x = toPageX(e.cp2.x, c), cp2y = toPageY(e.cp2.y, c);
  const p3x = toPageX(e.p3.x, c), p3y = toPageY(e.p3.y, c);
  doc.lines(
    [[cp1x - p0x, cp1y - p0y, cp2x - p0x, cp2y - p0y, p3x - p0x, p3y - p0y]],
    p0x, p0y, [1, 1], "S", false,
  );

  // Arrowhead — base at p3, tip at .tip. Same triangle the canvas paints.
  const ah = e.arrowHeadSize * c.zoom;
  const px = 0;
  const py = e.sign;
  const tipX = toPageX(e.tip.x, c), tipY = toPageY(e.tip.y, c);
  const baseAx = p3x + ah * 0.55 * px;
  const baseAy = p3y + ah * 0.55 * py;
  const baseBx = p3x - ah * 0.55 * px;
  const baseBy = p3y - ah * 0.55 * py;
  doc.lines(
    [[baseAx - tipX, baseAy - tipY, baseBx - tipX, baseBy - tipY, tipX - tipX, tipY - tipY]],
    tipX, tipY, [1, 1], "F", true,
  );
}

function drawPdfText(doc: jsPDF, shape: TextShape, theme: { foreground: string; headingColor: string; accent: string }, c: Camera) {
  const baseFontSize = shape.fontSize;
  const constraintWidth = shape.width && shape.width > 0 ? shape.width : undefined;

  // Measure callback uses jsPDF Helvetica-regular metrics. The wrap
  // points won't match Inter exactly, but they're consistent with the
  // PDF font we're about to render — which is what matters for layout.
  doc.setFont("helvetica", "normal");
  const measure = (text: string, fontSize: number): number => {
    doc.setFontSize(fontSize);
    return doc.getTextWidth(text);
  };

  const lines = parseText(shape.text, constraintWidth, baseFontSize, measure);

  const isDefaultColor = shape.color === "#000000";
  const textColor = isDefaultColor ? theme.foreground : shape.color;
  const headingColor = isDefaultColor ? theme.headingColor : shape.color;

  // Optional shape-wide background (==color highlight on the whole
  // box — separate from per-run ==highlight==).
  if (shape.backgroundColor) {
    const hex = COLOR_PALETTE[shape.backgroundColor] || shape.backgroundColor;
    const rgba = parseRgba(hex);
    if (rgba) {
      const b = getShapeBounds(shape);
      const pad = 4;
      doc.setFillColor(rgba.r, rgba.g, rgba.b);
      doc.setGState(doc.GState({ opacity: 0.9 }));
      doc.rect(
        toPageX(b.minX - pad, c),
        toPageY(b.minY - pad, c),
        (b.maxX - b.minX + pad * 2) * c.zoom,
        (b.maxY - b.minY + pad * 2) * c.zoom,
        "F",
      );
      doc.setGState(doc.GState({ opacity: 1 }));
    }
  }

  let yWorld = shape.position.y;
  for (const line of lines) {
    const lineFontSize = baseFontSize * line.sizeScale;
    const lineH = lineFontSize * LINE_HEIGHT_RATIO;
    const isHeading = line.sizeScale > 1;
    let xWorld = shape.position.x;

    for (const run of line.runs) {
      const fontSize = baseFontSize * run.sizeScale;
      const style = run.bold && run.italic ? "bolditalic" : run.bold ? "bold" : run.italic ? "italic" : "normal";
      doc.setFont("helvetica", style);
      doc.setFontSize(fontSize * c.zoom);

      const runWidth = (() => {
        doc.setFontSize(fontSize);
        const w = doc.getTextWidth(run.text);
        doc.setFontSize(fontSize * c.zoom);
        return w;
      })();

      // Per-run highlight band sits behind the glyphs.
      if (run.highlight) {
        const accent = parseRgba(theme.accent);
        if (accent) {
          doc.setFillColor(accent.r, accent.g, accent.b);
          doc.setGState(doc.GState({ opacity: 0.25 }));
          doc.rect(
            toPageX(xWorld, c),
            toPageY(yWorld, c),
            runWidth * c.zoom,
            (fontSize + 2) * c.zoom,
            "F",
          );
          doc.setGState(doc.GState({ opacity: 1 }));
        }
      }

      if (run.link) doc.setTextColor(theme.accent);
      else doc.setTextColor(isHeading ? headingColor : textColor);

      doc.text(
        run.text,
        toPageX(xWorld, c),
        toPageY(yWorld, c),
        { baseline: "top" },
      );

      if (run.link) {
        doc.setDrawColor(theme.accent);
        doc.setLineWidth(1);
        const ux = toPageX(xWorld, c);
        const uy = toPageY(yWorld + fontSize + 1, c);
        doc.line(ux, uy, ux + runWidth * c.zoom, uy);
      }

      xWorld += runWidth;
    }

    yWorld += lineH;
  }
}

function drawPdfImage(doc: jsPDF, shape: ImageShape, imageCache: Map<string, HTMLImageElement>, c: Camera) {
  const img = imageCache.get(shape.id);
  const x = toPageX(shape.position.x, c);
  const y = toPageY(shape.position.y, c);
  const w = shape.width * c.zoom;
  const h = shape.height * c.zoom;

  // Cropped images can't be re-cropped at PDF time without re-rasterizing.
  // Rather than embed the full source and clip it (jsPDF has no clip-path
  // primitive), bake the crop into a small canvas and embed that.
  let dataUrl: string | null = null;
  let format: "PNG" | "JPEG" = "JPEG";
  if (img && img.complete && shape.crop && (shape.crop.w !== 1 || shape.crop.h !== 1 || shape.crop.x !== 0 || shape.crop.y !== 0)) {
    const c2 = document.createElement("canvas");
    const tw = Math.max(1, Math.round(shape.crop.w * img.naturalWidth));
    const th = Math.max(1, Math.round(shape.crop.h * img.naturalHeight));
    c2.width = tw;
    c2.height = th;
    const cctx = c2.getContext("2d");
    if (cctx) {
      cctx.drawImage(
        img,
        shape.crop.x * img.naturalWidth, shape.crop.y * img.naturalHeight,
        shape.crop.w * img.naturalWidth, shape.crop.h * img.naturalHeight,
        0, 0, tw, th,
      );
      dataUrl = c2.toDataURL("image/jpeg", 0.92);
      format = "JPEG";
    }
  } else {
    dataUrl = shape.dataUrl;
    format = /^data:image\/png/i.test(dataUrl) ? "PNG" : "JPEG";
  }

  if (!dataUrl) {
    // Image isn't loaded yet — draw the placeholder the canvas would
    // have shown so the export doesn't silently drop the shape.
    doc.setFillColor(229, 231, 235);
    doc.rect(x, y, w, h, "F");
    doc.setDrawColor(156, 163, 175);
    doc.setLineWidth(1);
    doc.rect(x, y, w, h, "S");
    return;
  }
  try {
    doc.addImage(dataUrl, format, x, y, w, h, undefined, "FAST");
  } catch (err) {
    console.warn("[steiner] PDF image embed failed", err);
  }
}

function drawPdfStroke(doc: jsPDF, shape: DrawShape, c: Camera) {
  if (shape.points.length === 0) return;
  doc.setDrawColor(shape.color);
  doc.setLineWidth(shape.width * c.zoom);
  doc.setLineCap("round");
  doc.setLineJoin("round");

  if (shape.points.length === 1) {
    const x = toPageX(shape.points[0].x, c);
    const y = toPageY(shape.points[0].y, c);
    const r = (shape.width / 2) * c.zoom;
    doc.setFillColor(shape.color);
    doc.circle(x, y, r, "F");
    return;
  }

  // Convert absolute points to delta segments for jsPDF.lines.
  const deltas: number[][] = [];
  for (let i = 1; i < shape.points.length; i++) {
    const dx = (shape.points[i].x - shape.points[i - 1].x) * c.zoom;
    const dy = (shape.points[i].y - shape.points[i - 1].y) * c.zoom;
    deltas.push([dx, dy]);
  }
  doc.lines(deltas, toPageX(shape.points[0].x, c), toPageY(shape.points[0].y, c), [1, 1], "S", false);
}

function parseRgba(input: string | undefined): { r: number; g: number; b: number } | null {
  if (!input) return null;
  const hex = COLOR_PALETTE[input] || input;
  const m6 = hex.match(/^#?([0-9a-f]{6})$/i);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  const m3 = hex.match(/^#?([0-9a-f]{3})$/i);
  if (m3) {
    const v = m3[1];
    const r = parseInt(v[0] + v[0], 16);
    const g = parseInt(v[1] + v[1], 16);
    const b = parseInt(v[2] + v[2], 16);
    return { r, g, b };
  }
  return null;
}
