import type { DrawingState } from "../state";
import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "../types";
import { canvasToScreen } from "../utils";
import { h } from "./dom-helpers";

function toggleWrap(textarea: HTMLTextAreaElement, marker: string, state: DrawingState) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const value = textarea.value;
  const ml = marker.length;

  let newValue: string;
  let newStart: number;
  let newEnd: number;

  // Empty selection → insert paired markers, place caret between them.
  if (start === end) {
    newValue = value.slice(0, start) + marker + marker + value.slice(end);
    newStart = newEnd = start + ml;
  } else {
    const inner = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    // If the selection itself is already wrapped (e.g. "**foo**"), unwrap.
    if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= ml * 2) {
      const unwrapped = inner.slice(ml, inner.length - ml);
      newValue = before + unwrapped + after;
      newStart = start;
      newEnd = start + unwrapped.length;
    }
    // If the markers sit just outside the selection ("**foo**" with "foo"
    // selected), remove them.
    else if (
      before.endsWith(marker) &&
      after.startsWith(marker)
    ) {
      newValue = before.slice(0, before.length - ml) + inner + after.slice(ml);
      newStart = start - ml;
      newEnd = end - ml;
    } else {
      // Otherwise, wrap.
      newValue = before + marker + inner + marker + after;
      newStart = start + ml;
      newEnd = end + ml;
    }
  }

  textarea.value = newValue;
  textarea.setSelectionRange(newStart, newEnd);
  // Keep state in sync the same way the input listener does.
  if (state.editingText) {
    state.editingText = { ...state.editingText, text: newValue };
    state.notify("editingText");
  }
}

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

  // In brainstorm mode, Enter commits text (Shift+Enter for newline).
  // Cmd/Ctrl+Arrow shortcuts navigate the flowchart while editing:
  //   ⌘→  commit and edit a new child
  //   ⌘↓  commit and edit a new sibling (or new node below if no parent)
  //   ⌘↑  commit and jump back to the most recently edited node
  //   ⌘←  commit and edit the flowchart parent
  textarea.addEventListener("keydown", (e) => {
    if (!state.editingText) return;
    if (e.key === "Enter" && !e.shiftKey && state.brainstormMode) {
      e.preventDefault();
      state.commitText(state.editingText);
      state.editingText = null;
      state.notify("editingText");
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;

    // Markdown wrapping shortcuts: Cmd/Ctrl+B (bold), +I (italic),
    // +Shift+H (highlight). Toggle the markers around the current selection,
    // or insert paired markers at the cursor with the caret between them.
    const k = e.key.toLowerCase();
    if (k === "b" || k === "i" || (k === "h" && e.shiftKey)) {
      e.preventDefault();
      const marker = k === "b" ? "**" : k === "i" ? "*" : "==";
      toggleWrap(textarea, marker, state);
      return;
    }

    const key = e.key;
    if (
      key !== "ArrowRight" &&
      key !== "ArrowDown" &&
      key !== "ArrowUp" &&
      key !== "ArrowLeft"
    ) return;
    const editing = state.editingText;
    const hasText = editing.text.trim().length > 0;
    const wouldHaveCurrent = editing.shapeId || hasText;
    // ArrowUp (jump to most-recent) can work even from an empty new edit.
    // The others need a current context — otherwise let the default textarea
    // behavior (cursor navigation) happen.
    if (key !== "ArrowUp" && !wouldHaveCurrent) return;
    e.preventDefault();
    let currentId: string | null = editing.shapeId;
    if (hasText) {
      const committed = state.commitText(editing);
      if (committed) currentId = committed;
    }
    state.editingText = null;
    state.notify("editingText");
    if (key === "ArrowRight" && currentId) {
      state.startEditingFlowchartChild(currentId);
    } else if (key === "ArrowDown" && currentId) {
      state.startEditingFlowchartSibling(currentId);
    } else if (key === "ArrowUp") {
      state.startEditingMostRecent(currentId ?? undefined);
    } else if (key === "ArrowLeft" && currentId) {
      state.startEditingFlowchartParent(currentId);
    }
  });

  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      // If focus came back (e.g. the shortcut handlers re-focused this same
      // textarea on a new editing context), don't auto-commit.
      if (document.activeElement === textarea) return;
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
