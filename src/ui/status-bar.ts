import type { DrawingState } from "../state";
import { h } from "./dom-helpers";

export function createStatusBar(state: DrawingState): HTMLElement {
  const zoomSpan = h("span");
  const shapesSpan = h("span");
  const selectedSpan = h("span");
  const brainstormSpan = h("span", { style: { color: "#4285f4", fontWeight: "600" } });

  const bar = h("div", {
    style: {
      position: "absolute", bottom: "env(safe-area-inset-bottom)", left: "env(safe-area-inset-left)", display: "flex",
      alignItems: "center", padding: "0 12px", gap: "16px", height: "24px",
      fontSize: "11px", color: "#868e96", zIndex: "50",
      background: "rgba(255,255,255,0.7)", borderRadius: "0 8px 0 0",
    },
    children: [zoomSpan, shapesSpan, selectedSpan, brainstormSpan],
  });

  function update() {
    zoomSpan.textContent = Math.round(state.camera.zoom * 100) + "%";
    const n = state.shapes.length;
    shapesSpan.textContent = `${n} shape${n !== 1 ? "s" : ""}`;
    selectedSpan.textContent = state.selectedIds.size > 0 ? `${state.selectedIds.size} selected` : "";
    brainstormSpan.textContent = state.brainstormMode ? "💡 Brainstorm" : "";
  }

  state.addEventListener("change", update);
  update();
  return bar;
}
