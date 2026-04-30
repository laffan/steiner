import { NotesCanvas } from "../notes-canvas";
import type { Shape } from "../types";
import type { FlowEdge } from "../flowchart";
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

  function undo() { canvas.state.undo(); }
  function redo() { canvas.state.redo(); }

  return { el: stage, load, snapshot, flushPendingSave, findShape, focusShape, getCanvas: () => canvas, undo, redo };
}
