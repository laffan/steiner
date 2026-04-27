import { NotesCanvas } from "../notes-canvas";
import type { Shape } from "../types";
import type { FlowEdge } from "../flowchart";
import { getShapeBounds } from "../utils";
import { h } from "./dom-helpers";

export interface CanvasSnapshot {
  shapes: Shape[];
  flow_edges: FlowEdge[];
}

interface Options {
  onChange: (snapshot: CanvasSnapshot) => void;
}

const SAVE_DEBOUNCE_MS = 600;

export function createCanvasHost(opts: Options) {
  const stage = h("div", {
    style: {
      position: "relative",
      flex: "1",
      minWidth: "0",
      height: "100%",
      background: "#f4f5f7",
      overflow: "hidden",
    },
  });

  const canvas = new NotesCanvas(stage);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressSave = false;

  canvas.state.addEventListener("change", (e: Event) => {
    const detail = (e as CustomEvent).detail as { keys?: string[] } | undefined;
    if (!detail?.keys?.includes("shapes")) return;
    if (suppressSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      opts.onChange({
        shapes: canvas.getShapes(),
        flow_edges: canvas.state.flowchart.serialize(),
      });
    }, SAVE_DEBOUNCE_MS);
  });

  function load(snapshot: CanvasSnapshot | null) {
    suppressSave = true;
    try {
      canvas.loadShapes(snapshot?.shapes || []);
      canvas.state.flowchart.deserialize(snapshot?.flow_edges || []);
    } finally {
      setTimeout(() => {
        suppressSave = false;
      }, 50);
    }
  }

  function snapshot(): CanvasSnapshot {
    return {
      shapes: canvas.getShapes(),
      flow_edges: canvas.state.flowchart.serialize(),
    };
  }

  function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      opts.onChange(snapshot());
    }
  }

  function findShape(id: string): Shape | null {
    return canvas.getShapes().find((s) => s.id === id) || null;
  }

  function focusShape(id: string) {
    canvas.state.focusShape(id);
  }

  async function snapToPng(margin = 64): Promise<string | null> {
    const shapes = canvas.getShapes();
    if (shapes.length === 0) return null;

    // Compute the union of all shape bounds.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      const b = getShapeBounds(s);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    if (!isFinite(minX)) return null;

    // Save current camera, fit to content + margin, snap, restore.
    const prev = { ...canvas.state.camera };
    const cw = stage.clientWidth || window.innerWidth;
    const ch = stage.clientHeight || window.innerHeight;
    const contentW = (maxX - minX) + margin * 2;
    const contentH = (maxY - minY) + margin * 2;
    const zoom = Math.min(cw / contentW, ch / contentH, 1.0);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    canvas.state.camera = {
      x: cw / 2 - cx * zoom,
      y: ch / 2 - cy * zoom,
      zoom,
    };
    canvas.state.notify("camera");

    // Wait two frames so the renderer paints the new camera state.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const canvasEl = canvas.state.canvasEl;
    const dataUrl = canvasEl ? canvasEl.toDataURL("image/png") : null;

    // Restore.
    canvas.state.camera = prev;
    canvas.state.notify("camera");

    return dataUrl;
  }

  return { el: stage, load, snapshot, flushPendingSave, findShape, focusShape, snapToPng };
}
