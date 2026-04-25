import { FONT_FAMILY, LINE_HEIGHT_RATIO, COLOR_PALETTE } from "./types";
import type { Camera, DragAreaShape, ImageShape, Point, SelectionBox, Shape, TextShape } from "./types";
import type { CanvasTheme } from "./themes";
import { computePocketLayout, getShapeBounds, POCKET_ZONE_WIDTH, POCKET_TRAY_WIDTH } from "./utils";
import type { PocketEntry } from "./utils";
import { parseText } from "./markdown";

export interface RenderState {
  shapes: Shape[];
  selectedIds: Set<string>;
  camera: Camera;
  selectionBox: SelectionBox | null;
  creatingDragArea: { start: Point; end: Point } | null;
  editingShapeId: string | null;
  imageCache: Map<string, HTMLImageElement>;
  theme: CanvasTheme;
  croppingImageId: string | null;
  backgroundPattern: "grid" | "dot-grid" | "blank";
  gridSpacing: number;
  gridOpacity: number;
  fontFamily: string;
  isDragging: boolean;
}

export function render(canvas: HTMLCanvasElement, state: RenderState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const { camera, shapes, selectedIds, selectionBox, creatingDragArea, editingShapeId, imageCache, theme, backgroundPattern, gridSpacing, gridOpacity } = state;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = theme.canvasBackground;
  ctx.fillRect(0, 0, w, h);

  if (backgroundPattern !== "blank" && gridOpacity > 0) {
    // Use foreground color at scaled opacity (100% slider = 80% alpha of foreground)
    drawBackground(ctx, camera, w, h, theme.foreground, backgroundPattern, gridSpacing, gridOpacity * 0.8);
  }

  // Compute pocket layout once for this frame
  const pocketLayout = computePocketLayout(shapes, w, state.fontFamily);
  const pocketedIds = pocketLayout.pocketedIds;

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  for (const shape of shapes) {
    if (shape.type === "drag-area") {
      if (!pocketedIds.has(shape.id)) drawDragArea(ctx, shape);
    }
  }

  for (const shape of shapes) {
    if (shape.type === "drag-area") continue;
    if (shape.id === editingShapeId) continue;
    if (pocketedIds.has(shape.id)) continue;
    if (shape.type === "draw") drawStroke(ctx, shape.points, shape.color, shape.width);
    else if (shape.type === "text") drawTextShape(ctx, shape, theme, state.fontFamily);
    else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, shape.id === state.croppingImageId);
  }

  if (creatingDragArea) {
    const { start, end } = creatingDragArea;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const rw = Math.abs(end.x - start.x);
    const rh = Math.abs(end.y - start.y);
    ctx.save();
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.fillStyle = "rgba(107, 114, 128, 0.08)";
    ctx.beginPath();
    roundRect(ctx, x, y, rw, rh, 12);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  if (selectedIds.size > 0) {
    // Draw group bounding boxes first (behind individual highlights)
    const groupBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const shape of shapes) {
      if (!selectedIds.has(shape.id) || pocketedIds.has(shape.id) || !shape.groupId) continue;
      const b = getShapeBounds(shape);
      const existing = groupBounds.get(shape.groupId);
      if (existing) {
        existing.minX = Math.min(existing.minX, b.minX);
        existing.minY = Math.min(existing.minY, b.minY);
        existing.maxX = Math.max(existing.maxX, b.maxX);
        existing.maxY = Math.max(existing.maxY, b.maxY);
      } else {
        groupBounds.set(shape.groupId, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      }
    }
    for (const bounds of groupBounds.values()) {
      drawGroupHighlight(ctx, bounds, camera.zoom, theme.accent);
    }

    for (const shape of shapes) {
      if (selectedIds.has(shape.id) && !pocketedIds.has(shape.id)) {
        if (shape.id === state.croppingImageId && shape.type === "image") {
          drawCropOverlay(ctx, shape, camera.zoom);
        } else {
          drawSelectionHighlight(ctx, shape, camera.zoom, theme.accent);
        }
      }
    }
  }

  ctx.restore();

  // Draw pocket tray on left edge (always visible when items are pocketed, or during drag)
  const hasPocketed = pocketLayout.entries.length > 0;
  if (hasPocketed || state.isDragging) {
    drawPocketTray(ctx, w, h, state.isDragging, hasPocketed);
  }

  // Draw pocketed shapes at fixed screen positions (outside camera transform)
  if (hasPocketed) {
    drawPocketEntries(ctx, pocketLayout.entries, selectedIds, theme, state.fontFamily, imageCache);
  }

  if (selectionBox) drawSelectionBox(ctx, selectionBox, camera);
}

// === Draw helpers (pure Canvas 2D — no framework dependencies) ===

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawDragArea(ctx: CanvasRenderingContext2D, shape: DragAreaShape) {
  const { position, width, height, strokeColor, backgroundColor, borderRadius } = shape;
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.fillStyle = backgroundColor;
  ctx.beginPath();
  roundRect(ctx, position.x, position.y, width, height, borderRadius);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawStroke(ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawTextShape(ctx: CanvasRenderingContext2D, shape: TextShape, theme: CanvasTheme, fontFamily: string) {
  const baseFontSize = shape.fontSize;
  const ff = `${fontFamily}, ${FONT_FAMILY}`;

  // Measure function using the render context for accurate width
  const measure = (text: string, fontSize: number): number => {
    ctx.font = `${fontSize}px ${ff}`;
    return ctx.measureText(text).width;
  };

  // Parse markdown into styled lines
  const parsedLines = parseText(
    shape.text,
    shape.width && shape.width > 0 ? shape.width : undefined,
    baseFontSize,
    measure,
  );

  // Resolve text color: use theme foreground if shape uses default black
  const isDefaultColor = shape.color === "#000000";
  const textColor = isDefaultColor ? theme.foreground : shape.color;
  const headingColor = isDefaultColor ? theme.headingColor : shape.color;

  // Draw background if set
  if (shape.backgroundColor) {
    const hex = COLOR_PALETTE[shape.backgroundColor] || shape.backgroundColor;
    const bounds = getShapeBounds(shape, fontFamily);
    const pad = 4;
    ctx.save();
    ctx.fillStyle = hex;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(bounds.minX - pad, bounds.minY - pad, bounds.maxX - bounds.minX + pad * 2, bounds.maxY - bounds.minY + pad * 2);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  ctx.save();
  ctx.textBaseline = "top";

  let y = shape.position.y;
  for (const line of parsedLines) {
    const lineScale = line.sizeScale;
    const lineFontSize = baseFontSize * lineScale;
    const lineH = lineFontSize * LINE_HEIGHT_RATIO;
    const isHeading = lineScale > 1;
    let x = shape.position.x;

    ctx.fillStyle = isHeading ? headingColor : textColor;

    for (const run of line.runs) {
      const weight = run.bold ? "bold" : "normal";
      const style = run.italic ? "italic" : "normal";
      const fontSize = baseFontSize * run.sizeScale;
      ctx.font = `${style} ${weight} ${fontSize}px ${ff}`;
      if (run.highlight) {
        ctx.save();
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(x, y, ctx.measureText(run.text).width, fontSize + 2);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      if (run.link) ctx.fillStyle = theme.accent;
      else ctx.fillStyle = isHeading ? headingColor : textColor;
      ctx.fillText(run.text, x, y);
      const runW = ctx.measureText(run.text).width;
      if (run.link) {
        ctx.beginPath();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1;
        ctx.moveTo(x, y + fontSize + 1);
        ctx.lineTo(x + runW, y + fontSize + 1);
        ctx.stroke();
      }
      x += runW;
    }

    y += lineH;
  }
  ctx.restore();
}

function drawImageShape(ctx: CanvasRenderingContext2D, shape: ImageShape, imageCache: Map<string, HTMLImageElement>, isCropping?: boolean) {
  const img = imageCache.get(shape.id);
  if (img && img.complete) {
    const c = shape.crop || { x: 0, y: 0, w: 1, h: 1 };
    if (isCropping) {
      // Show the full image at 50% opacity behind the crop
      const fullW = shape.width / c.w, fullH = shape.height / c.h;
      const fullX = shape.position.x - c.x * fullW, fullY = shape.position.y - c.y * fullH;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(img, fullX, fullY, fullW, fullH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    const sx = c.x * img.naturalWidth, sy = c.y * img.naturalHeight;
    const sw = c.w * img.naturalWidth, sh = c.h * img.naturalHeight;
    ctx.drawImage(img, sx, sy, sw, sh, shape.position.x, shape.position.y, shape.width, shape.height);
  } else {
    ctx.save();
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.strokeRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shape.name || "Image", shape.position.x + shape.width / 2, shape.position.y + shape.height / 2);
    ctx.restore();
  }
}

function drawSelectionHighlight(ctx: CanvasRenderingContext2D, shape: Shape, zoom: number, accentColor: string) {
  const bounds = getShapeBounds(shape);
  const pad = 6;
  const x1 = bounds.minX - pad, y1 = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;

  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);

  const handleSize = 7 / zoom;
  const half = handleSize / 2;
  const mx = x1 + w / 2, my = y1 + h / 2;
  const handles: [number, number][] = [
    [x1, y1], [x1 + w, y1], [x1, y1 + h], [x1 + w, y1 + h],
    [mx, y1], [mx, y1 + h], [x1, my], [x1 + w, my],
  ];
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 / zoom;
  for (const [hx, hy] of handles) {
    ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
    ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
  }
  ctx.restore();
}

function drawGroupHighlight(ctx: CanvasRenderingContext2D, bounds: { minX: number; minY: number; maxX: number; maxY: number }, zoom: number, accentColor: string) {
  const pad = 14;
  const x1 = bounds.minX - pad, y1 = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, box: SelectionBox, camera: Camera) {
  const x1 = box.start.x * camera.zoom + camera.x;
  const y1 = box.start.y * camera.zoom + camera.y;
  const x2 = box.end.x * camera.zoom + camera.x;
  const y2 = box.end.y * camera.zoom + camera.y;
  ctx.save();
  ctx.fillStyle = "rgba(66, 133, 244, 0.08)";
  ctx.strokeStyle = "#4285f4";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawCropOverlay(ctx: CanvasRenderingContext2D, shape: ImageShape, zoom: number) {
  // Show red border and handles on the image bounds during crop mode
  const pad = 2;
  const x = shape.position.x - pad, y = shape.position.y - pad;
  const w = shape.width + pad * 2, ht = shape.height + pad * 2;
  ctx.save();
  ctx.strokeStyle = "#ea4335";
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([6 / zoom, 3 / zoom]);
  ctx.strokeRect(x, y, w, ht);
  ctx.setLineDash([]);
  // Red corner handles
  const handleSize = 8 / zoom;
  const half = handleSize / 2;
  const mx = x + w / 2, my = y + ht / 2;
  const handles: [number, number][] = [
    [x, y], [x + w, y], [x, y + ht], [x + w, y + ht],
    [mx, y], [mx, y + ht], [x, my], [x + w, my],
  ];
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#ea4335";
  ctx.lineWidth = 2 / zoom;
  for (const [hx, hy] of handles) {
    ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
    ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
  }
  ctx.restore();
}

const POCKET_BLUE = "rgba(66, 153, 225, 0.18)";
const POCKET_BLUE_HIGHLIGHT = "rgba(66, 153, 225, 0.30)";

function drawPocketTray(ctx: CanvasRenderingContext2D, _w: number, h: number, isDragging: boolean, hasPocketed: boolean) {
  ctx.save();
  // 20px light blue strip on the left edge
  ctx.fillStyle = isDragging ? POCKET_BLUE_HIGHLIGHT : POCKET_BLUE;
  ctx.fillRect(0, 0, POCKET_TRAY_WIDTH, h);
  // Softer extended highlight during drags so users see the drop zone
  if (isDragging) {
    const gradient = ctx.createLinearGradient(POCKET_TRAY_WIDTH, 0, POCKET_ZONE_WIDTH, 0);
    gradient.addColorStop(0, "rgba(66, 153, 225, 0.10)");
    gradient.addColorStop(1, "transparent");
    ctx.fillStyle = gradient;
    ctx.fillRect(POCKET_TRAY_WIDTH, 0, POCKET_ZONE_WIDTH - POCKET_TRAY_WIDTH, h);
  } else if (hasPocketed) {
    // Subtle fade when items are present
    const gradient = ctx.createLinearGradient(POCKET_TRAY_WIDTH, 0, POCKET_TRAY_WIDTH + 6, 0);
    gradient.addColorStop(0, "rgba(66, 153, 225, 0.06)");
    gradient.addColorStop(1, "transparent");
    ctx.fillStyle = gradient;
    ctx.fillRect(POCKET_TRAY_WIDTH, 0, 6, h);
  }
  ctx.restore();
}

function drawPocketEntries(
  ctx: CanvasRenderingContext2D, entries: PocketEntry[], selectedIds: Set<string>,
  theme: CanvasTheme, fontFamily: string, imageCache: Map<string, HTMLImageElement>,
) {
  for (const entry of entries) {
    const b = entry.screenBounds;
    const pad = 6;

    // Light blue card background
    ctx.save();
    ctx.fillStyle = POCKET_BLUE;
    ctx.shadowColor = "rgba(0,0,0,0.08)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    roundRect(ctx, b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2, 6);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(66, 153, 225, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Draw shapes with offset + scale transform
    ctx.save();
    ctx.translate(entry.offsetX, entry.offsetY);
    if (entry.scale !== 1) ctx.scale(entry.scale, entry.scale);
    for (const shape of entry.shapes) {
      if (shape.type === "drag-area") drawDragArea(ctx, shape);
    }
    for (const shape of entry.shapes) {
      if (shape.type === "drag-area") continue;
      if (shape.type === "text") drawTextShape(ctx, shape, theme, fontFamily);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, false);
      else if (shape.type === "draw") drawStroke(ctx, shape.points, shape.color, shape.width);
    }
    // Selection highlights for pocketed shapes
    for (const shape of entry.shapes) {
      if (selectedIds.has(shape.id)) {
        drawSelectionHighlight(ctx, shape, 1 / entry.scale, theme.accent);
      }
    }
    ctx.restore();
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, camera: Camera, w: number, h: number, color: string, pattern: "grid" | "dot-grid", spacing: number, opacity: number) {
  const scaledSize = spacing * camera.zoom;
  if (scaledSize < 6) return;
  const offsetX = camera.x % scaledSize;
  const offsetY = camera.y % scaledSize;
  ctx.save();
  ctx.globalAlpha = opacity;
  if (pattern === "grid") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    for (let x = offsetX; x < w; x += scaledSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = offsetY; y < h; y += scaledSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  } else {
    ctx.fillStyle = color;
    const radius = Math.max(0.8, scaledSize / 25);
    for (let x = offsetX; x < w; x += scaledSize) {
      for (let y = offsetY; y < h; y += scaledSize) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
