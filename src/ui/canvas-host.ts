import { NotesCanvas } from "../notes-canvas";
import type { Camera, Shape } from "../types";
import type { FlowEdge, FlowConnectMode } from "../flowchart";
import { h } from "./dom-helpers";
import { loadFlowConnectMode } from "./flow-prefs";

export interface CanvasSnapshot {
  shapes: Shape[];
  flow_edges: FlowEdge[];
  /** Pan + zoom. Persisted so refreshing or reopening a session restores
   *  the user's view instead of jumping back to the origin. */
  camera?: Camera;
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
  canvas.state.flowchart.setConnectMode(loadFlowConnectMode());

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressSave = false;

  canvas.state.addEventListener("change", (e: Event) => {
    const keys = (e as CustomEvent).detail?.keys as string[] | undefined;
    // Save on shape edits AND camera moves (pan/zoom). Both notify through
    // the same change event with their key in `keys`; a single debounce
    // coalesces a burst of pan-frames into one write.
    if (!keys || (!keys.includes("shapes") && !keys.includes("camera"))) return;
    if (suppressSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      opts.onChange(snapshot());
    }, SAVE_DEBOUNCE_MS);
  });

  function load(snap: CanvasSnapshot | null) {
    suppressSave = true;
    try {
      canvas.loadShapes(snap?.shapes || []);
      canvas.state.flowchart.deserialize(snap?.flow_edges || []);
      // Default to origin when a session has no saved camera (legacy data
      // or a freshly-created session); otherwise the previous session's
      // camera would bleed through and disorient the user.
      canvas.state.camera = snap?.camera
        ? { x: snap.camera.x, y: snap.camera.y, zoom: snap.camera.zoom }
        : { x: 0, y: 0, zoom: 1 };
      canvas.state.notify("camera");
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
      camera: { ...canvas.state.camera },
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

  function setFlowConnectMode(mode: FlowConnectMode) {
    canvas.state.flowchart.setConnectMode(mode);
    canvas.state.notify("shapes");
  }

  return { el: stage, load, snapshot, flushPendingSave, findShape, focusShape, getCanvas: () => canvas, undo, redo, setFlowConnectMode };
}
