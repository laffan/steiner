import type { DrawingState } from "../state";
import type { Point, TextShape } from "../types";
import { canvasToScreen, generateId, getShapeBounds, screenToCanvas } from "../utils";
import { h } from "./dom-helpers";

/**
 * Brainstorm mode: a persistent text input that stays at a click location.
 * Each Enter press creates a text shape placed in an expanding spiral
 * around the input position. The input stays open for rapid entry.
 */
export function createBrainstormInput(state: DrawingState): HTMLElement {
  const container = h("div", {
    style: { position: "absolute", zIndex: "250", display: "none", pointerEvents: "auto" },
  });

  const inputRow = h("div", {
    style: {
      display: "flex", alignItems: "center", gap: "0",
      background: "#fff", borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      border: "1px solid #4285f4",
      overflow: "hidden",
    },
  });

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Press enter";
  Object.assign(input.style, {
    width: "200px", padding: "6px 10px", border: "none", outline: "none",
    fontSize: "14px", fontFamily: "inherit", background: "transparent",
  });

  const closeBtn = h("button", {
    text: "×",
    style: {
      width: "32px", height: "32px", border: "none", borderLeft: "1px solid #e5e7eb",
      background: "#f8f9fa", cursor: "pointer", fontSize: "16px", color: "#999",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0",
    },
    onClick: () => hide(),
  });

  inputRow.appendChild(input);
  inputRow.appendChild(closeBtn);
  container.appendChild(inputRow);

  // Track placement state
  let canvasOrigin: Point = { x: 0, y: 0 }; // canvas-space origin of the input
  let placedPositions: Point[] = [];
  let quadrantIndex = 0;
  let visible = false;

  function show(screenX: number, screenY: number) {
    canvasOrigin = screenToCanvas({ x: screenX, y: screenY }, state.camera);
    placedPositions = [];
    quadrantIndex = 0;
    container.style.display = "block";
    container.style.left = screenX + "px";
    container.style.top = screenY + "px";
    visible = true;
    setTimeout(() => input.focus(), 20);
  }

  function hide() {
    if (!visible) return;
    container.style.display = "none";
    visible = false;
    input.value = "";
    state.brainstormMode = false;
    state.tool = "select";
    state.notify("brainstormMode");
    state.notify("tool");
  }

  function updatePosition() {
    if (!visible) return;
    const screenPos = canvasToScreen(canvasOrigin, state.camera);
    container.style.left = screenPos.x + "px";
    container.style.top = screenPos.y + "px";
  }

  // Submit on Enter
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      // Find position in spiral around origin
      const pos = findSpiralPosition(canvasOrigin, placedPositions, state);
      placedPositions.push(pos);
      quadrantIndex++;

      // Create text shape
      const newShape: TextShape = {
        id: generateId(),
        type: "text",
        position: pos,
        text,
        fontSize: state.fontSize,
        color: state.color,
      };
      state.shapes = [...state.shapes, newShape];
      state.recordHistory();
      state.notify("shapes");

      input.value = "";
      input.focus();
    }
    if (e.key === "Escape") {
      hide();
    }
  });

  // Prevent canvas pointer events from stealing focus
  container.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Listen for brainstorm mode + click on canvas
  // The state handler sets brainstormMode but we intercept canvas clicks here
  function handleCanvasClick(e: PointerEvent) {
    if (!state.brainstormMode) { if (visible) hide(); return; }
    if (e.button !== 0) return;

    // Don't intercept if clicking on UI elements
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.tagName === "INPUT") return;

    const canvas = state.canvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (visible) {
      // Move the input to the new click location
      show(screenX, screenY);
    } else {
      show(screenX, screenY);
    }
  }

  // Update position when camera moves
  state.addEventListener("change", (ev) => {
    const detail = (ev as CustomEvent).detail;
    if (detail?.keys?.includes("camera")) updatePosition();
    if (detail?.keys?.includes("brainstormMode") && !state.brainstormMode) hide();
  });

  // We need to register the click handler on the canvas — but it doesn't exist yet.
  // Do it after the canvas is set.
  const checkCanvas = setInterval(() => {
    if (state.canvasEl) {
      state.canvasEl.addEventListener("pointerdown", handleCanvasClick, { capture: true });
      clearInterval(checkCanvas);
    }
  }, 50);

  return container;
}

/**
 * Find a position in an expanding spiral around the origin,
 * avoiding collisions with existing shapes and previously placed items.
 */
function findSpiralPosition(
  origin: Point,
  placed: Point[],
  state: DrawingState,
): Point {
  const distances = [120, 160, 200, 240, 280];
  const angleStep = 30; // degrees
  const startAngle = 45; // start upper-right

  for (const dist of distances) {
    for (let a = 0; a < 360; a += angleStep) {
      const angle = ((startAngle + a) % 360) * (Math.PI / 180);
      const x = origin.x + Math.cos(angle) * dist;
      const y = origin.y - Math.sin(angle) * dist; // negative because canvas Y is down

      // Check collision with placed items (60px min spacing)
      const tooCloseToPlaced = placed.some((p) => {
        const dx = p.x - x, dy = p.y - y;
        return Math.sqrt(dx * dx + dy * dy) < 60;
      });
      if (tooCloseToPlaced) continue;

      // Check collision with existing shapes (20px padding)
      const testBounds = { minX: x - 10, minY: y - 10, maxX: x + 100, maxY: y + 30 };
      const overlapsShape = state.shapes.some((s) => {
        const sb = getShapeBounds(s);
        return sb.minX < testBounds.maxX + 20 && sb.maxX > testBounds.minX - 20 &&
               sb.minY < testBounds.maxY + 20 && sb.maxY > testBounds.minY - 20;
      });
      if (overlapsShape) continue;

      return { x, y };
    }
  }

  // Fallback: random angle at 200px
  const angle = Math.random() * Math.PI * 2;
  return { x: origin.x + Math.cos(angle) * 200, y: origin.y + Math.sin(angle) * 200 };
}
