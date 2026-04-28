import type { DrawingState } from "../state";
import { canvasToScreen, getShapeBounds } from "../utils";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";

const BUTTON_SIZE = 24;
/** Pixel gap between the parent shape's top edge and the button's bottom edge. */
const GAP = 8;

/**
 * Floats a small "tidy" button above every text shape that has flowchart
 * children. Clicking the button re-layouts that subtree via state.tidySubtree.
 */
export function createTidyOverlay(state: DrawingState): HTMLElement {
  const container = h("div", {
    style: {
      position: "absolute",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      overflow: "visible",
      pointerEvents: "none",
      zIndex: "150",
    },
  });

  function makeButton(shapeId: string): HTMLButtonElement {
    const theme = state.theme;
    const btn = h("button", {
      title: "Tidy subtree",
      style: {
        position: "absolute",
        width: `${BUTTON_SIZE}px`,
        height: `${BUTTON_SIZE}px`,
        padding: "0",
        border: `1px solid ${theme.foreground}`,
        borderRadius: "50%",
        background: theme.uiBackground,
        color: theme.foreground,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "auto",
        boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
      },
      children: [icon("tidy", 16)],
    }) as HTMLButtonElement;
    // Don't let the click bubble to the canvas (which would deselect / pan).
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.tidySubtree(shapeId);
    });
    return btn;
  }

  function update() {
    clearChildren(container);
    if (!state.flowchart) return;
    for (const shape of state.shapes) {
      if (shape.type !== "text") continue;
      if (shape.pocketed) continue;
      if (state.flowchart.childrenOf(shape.id).length === 0) continue;
      const b = getShapeBounds(shape);
      const topCenter = canvasToScreen(
        { x: (b.minX + b.maxX) / 2, y: b.minY },
        state.camera,
      );
      const btn = makeButton(shape.id);
      btn.style.left = `${topCenter.x - BUTTON_SIZE / 2}px`;
      btn.style.top = `${topCenter.y - GAP - BUTTON_SIZE}px`;
      container.appendChild(btn);
    }
  }

  state.addEventListener("change", update);
  update();
  return container;
}
