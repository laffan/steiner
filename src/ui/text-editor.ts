import type { DrawingState } from "../state";
import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "../types";
import { canvasToScreen } from "../utils";
import { h } from "./dom-helpers";

export function createTextEditor(state: DrawingState): HTMLElement {
  const container = h("div", { style: { position: "absolute", top: "0", left: "0", width: "0", height: "0", overflow: "visible", zIndex: "200", pointerEvents: "none" } });

  const measureDiv = h("div", {
    style: { position: "absolute", visibility: "hidden", height: "auto", width: "auto", padding: "0", border: "none", pointerEvents: "none", whiteSpace: "pre", wordBreak: "keep-all" },
    attrs: { "aria-hidden": "true" },
  });
  container.appendChild(measureDiv);

  const textarea = document.createElement("textarea");
  textarea.className = "inline-text-editor";
  Object.assign(textarea.style, {
    position: "absolute", background: "transparent", border: "none", outline: "none",
    padding: "0", margin: "0", resize: "none", overflow: "hidden",
    minWidth: "20px", zIndex: "200", boxSizing: "content-box",
    whiteSpace: "pre", wordBreak: "keep-all", pointerEvents: "auto", display: "none",
  });
  container.appendChild(textarea);

  textarea.addEventListener("input", () => {
    if (!state.editingText) return;
    state.editingText = { ...state.editingText, text: textarea.value };
    state.notify("editingText");
  });

  // In brainstorm mode, Enter commits text (Shift+Enter for newline)
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && state.brainstormMode && state.editingText) {
      e.preventDefault();
      state.commitText(state.editingText);
      state.editingText = null;
      state.notify("editingText");
    }
  });

  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      if (!state.editingText) return;
      state.commitText(state.editingText);
      state.editingText = null;
      state.notify("editingText");
    }, 150);
  });

  function update() {
    if (!state.editingText) {
      textarea.style.display = "none";
      return;
    }

    const et = state.editingText;
    const scaledFontSize = et.fontSize * state.camera.zoom;
    const scaledLineHeight = scaledFontSize * LINE_HEIGHT_RATIO;
    const screenPos = canvasToScreen(et.position, state.camera);

    const fontStyle = {
      fontFamily: `${state.fontFamily}, ${FONT_FAMILY}`,
      fontSize: scaledFontSize + "px",
      lineHeight: scaledLineHeight + "px",
    };

    Object.assign(measureDiv.style, fontStyle);
    const resolvedColor = et.color === "#000000" ? state.theme.foreground : et.color;
    const isEmpty = !et.text;
    Object.assign(textarea.style, fontStyle, {
      display: "block",
      left: screenPos.x + "px",
      top: screenPos.y + "px",
      color: resolvedColor,
      // Hide native caret when showing custom blinking border; show it once typing
      caretColor: isEmpty ? "transparent" : resolvedColor,
      minHeight: (scaledLineHeight + 4) + "px",
      // Blinking left border as cursor indicator when empty
      borderLeft: isEmpty ? `2px solid ${resolvedColor}` : "none",
      paddingLeft: isEmpty ? "2px" : "0",
    });
    textarea.classList.toggle("empty-cursor", isEmpty);

    // Sync value if different (avoid cursor jump)
    if (textarea.value !== et.text) textarea.value = et.text;

    // Auto-resize — respect width constraint if the shape has one
    const hasWidth = et.width && et.width > 0;
    const scaledWidth = hasWidth ? et.width! * state.camera.zoom : 0;

    if (hasWidth) {
      // Fixed width: textarea wraps within the shape's width
      textarea.style.whiteSpace = "pre-wrap";
      textarea.style.wordBreak = "break-word";
      textarea.style.width = scaledWidth + "px";
      measureDiv.style.whiteSpace = "pre-wrap";
      measureDiv.style.wordBreak = "break-word";
      measureDiv.style.width = scaledWidth + "px";
    } else {
      // Auto-width: grow with content
      textarea.style.whiteSpace = "pre";
      textarea.style.wordBreak = "keep-all";
      textarea.style.width = "auto";
      measureDiv.style.whiteSpace = "pre";
      measureDiv.style.wordBreak = "keep-all";
      measureDiv.style.width = "auto";
    }

    measureDiv.textContent = et.text || "\u00A0";
    if (et.text.endsWith("\n")) measureDiv.textContent += "\u00A0";

    if (!hasWidth) {
      textarea.style.width = (measureDiv.scrollWidth + 2) + "px";
    }
    textarea.style.height = measureDiv.scrollHeight + "px";

    // Focus with delay
    if (document.activeElement !== textarea) {
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 20);
    }
  }

  state.addEventListener("change", update);
  update();
  return container;
}
