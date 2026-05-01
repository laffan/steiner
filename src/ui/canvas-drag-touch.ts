/**
 * Pointer-based drag-to-canvas for sources that need to ship text from the
 * chat panel (chips, segment spans, plain bubbles) onto the canvas. Lives
 * alongside the existing HTML5 `draggable="true"` + `dragstart` handlers —
 * mouse uses the native path, touch uses this one.
 *
 * Why both: HTML5 drag-and-drop doesn't fire reliably on iOS touch, and on
 * desktop the native drag image / cursor look better than anything we can
 * build with pointer events. So we keep both wired and let pointerType
 * decide which fires.
 *
 * On `pointerup` the helper hit-tests via `document.elementFromPoint` and,
 * if the cursor lands on a `<canvas>`, dispatches a `steiner-touch-drop`
 * CustomEvent. input-handler.ts subscribes to that event and routes the
 * payload through the same applyAskPayload helper that handles HTML5 drops.
 */

import type { AskDropPayload } from "../input-handler";

const MOVE_THRESHOLD_PX = 8;
const GHOST_OFFSET_PX = 12;

/**
 * Make `el` participate in pointer-driven canvas drag. Only fires for
 * `pointerType === "touch"` (and `"pen"` so Apple Pencil works on iPad);
 * mouse drags are left to the existing HTML5 drag handlers on the same
 * element.
 *
 * @param el         The drag handle.
 * @param getPayload Called at pointerdown. Return the same shape that
 *                   the HTML5 dragstart handler puts in
 *                   `application/x-steiner-ask`.
 */
export function enableTouchDrag(
  el: HTMLElement,
  getPayload: () => AskDropPayload | null,
): void {
  let startX = 0;
  let startY = 0;
  let started = false;
  let payload: AskDropPayload | null = null;
  let ghost: HTMLElement | null = null;
  let activePointerId: number | null = null;

  function buildGhost(text: string, x: number, y: number): HTMLElement {
    const g = document.createElement("div");
    // Trim to a single short line — the ghost is feedback, not a faithful
    // preview of the dragged content.
    const preview = text.replace(/\s+/g, " ").slice(0, 80);
    g.textContent = preview || "…";
    Object.assign(g.style, {
      position: "fixed",
      left: `${x + GHOST_OFFSET_PX}px`,
      top: `${y + GHOST_OFFSET_PX}px`,
      pointerEvents: "none",
      background: "#fff",
      border: "1px solid #888",
      borderRadius: "8px",
      padding: "6px 10px",
      fontSize: "12px",
      fontFamily: "inherit",
      color: "#0f0f0f",
      boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
      maxWidth: "260px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      zIndex: "10000",
      opacity: "0.95",
    } as Partial<CSSStyleDeclaration>);
    return g;
  }

  function reset(e: PointerEvent | null) {
    if (e !== null) {
      try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    }
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    if (ghost) ghost.remove();
    ghost = null;
    started = false;
    payload = null;
    activePointerId = null;
  }

  function onMove(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    if (!payload) return;
    if (!started) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD_PX) return;
      started = true;
      ghost = buildGhost(payload.text, e.clientX, e.clientY);
      document.body.appendChild(ghost);
      // Block the page from interpreting the same gesture as a scroll.
      e.preventDefault();
    } else if (ghost) {
      ghost.style.left = `${e.clientX + GHOST_OFFSET_PX}px`;
      ghost.style.top = `${e.clientY + GHOST_OFFSET_PX}px`;
      e.preventDefault();
    }
  }

  function onUp(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    const wasStarted = started;
    const finalPayload = payload;
    const x = e.clientX;
    const y = e.clientY;
    // Hide the ghost first so elementFromPoint sees what's underneath the
    // cursor rather than the ghost div itself.
    if (ghost) ghost.style.display = "none";
    let target: Element | null = null;
    if (wasStarted) {
      target = document.elementFromPoint(x, y);
    }
    reset(e);
    if (!wasStarted || !finalPayload) return;
    const canvas = target instanceof HTMLCanvasElement ? target : target?.closest("canvas");
    if (!canvas) return;
    window.dispatchEvent(
      new CustomEvent("steiner-touch-drop", {
        detail: { payload: finalPayload, clientX: x, clientY: y },
      }),
    );
  }

  function onCancel(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    reset(e);
  }

  el.addEventListener("pointerdown", (e: PointerEvent) => {
    // Mouse path stays on HTML5 drag — it has nicer native feedback (the
    // OS-level drag preview, real cursor changes) than anything we render.
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    if (activePointerId !== null) return;
    const p = getPayload();
    if (!p || !p.text.trim()) return;
    payload = p;
    activePointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    started = false;
    try { el.setPointerCapture(e.pointerId); } catch { /* */ }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  });
}

// Augment the global event map so input-handler's `on(window, "steiner-touch-drop", ...)`
// is type-safe without casts.
declare global {
  interface WindowEventMap {
    "steiner-touch-drop": CustomEvent<{
      payload: AskDropPayload;
      clientX: number;
      clientY: number;
    }>;
  }
  interface HTMLElementEventMap {
    "steiner-touch-drop": CustomEvent<{
      payload: AskDropPayload;
      clientX: number;
      clientY: number;
    }>;
  }
}
