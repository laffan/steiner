import "./index.css";
import { NotesCanvas } from "./notes-canvas";
import { SteinerBridge } from "./steiner-bridge";

const root = document.getElementById("root");
if (root) {
  const canvas = new NotesCanvas(root);
  const bridge = new SteinerBridge(canvas);
  // Expose for the selection toolbar to reach via a known global.
  (window as unknown as { steiner: SteinerBridge }).steiner = bridge;
  bridge.init();
}
