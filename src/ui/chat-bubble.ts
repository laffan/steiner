import type { Segment, SegmentKind } from "../api";
import { h } from "./dom-helpers";
import { renderMarkdownToFragment } from "./markdown-render";

const DRAG_MIME = "application/x-steiner-ask";

export const HIGHLIGHT_STYLE: Record<Exclude<SegmentKind, "text">, Partial<CSSStyleDeclaration>> = {
  concept: {
    background: "#fff4c4",
    color: "#6b4f00",
    fontWeight: "500",
  },
  name: {
    background: "#dce6ff",
    color: "#1f3a7d",
    fontWeight: "500",
  },
  book: {
    background: "#f0e8f7",
    color: "#4d2a80",
    fontStyle: "italic",
    fontWeight: "500",
  },
  definition: {
    background: "#d9efd6",
    color: "#2a5a1f",
    fontStyle: "italic",
  },
};

/** Kinds shown as filter chips in the Terms tab. */
export const TERM_KINDS: Exclude<SegmentKind, "text" | "definition">[] = ["concept", "name", "book"];

interface BubbleArgs {
  role: "user" | "assistant";
  content: string;
  /** Term metadata kept on the message for the Terms tab. Not used by the
   *  bubble's own rendering — see makeChatBubble. */
  segments?: Segment[];
  sourceShapeIds: string[];
}

export function makeChatBubble(args: BubbleArgs): HTMLElement {
  const { role, content, sourceShapeIds } = args;

  const bubble = h("div", {
    style: {
      maxWidth: "100%",
      padding: "8px 12px",
      borderRadius: "12px",
      // pre-wrap is dropped for assistants — markdown rendering owns its own
      // whitespace. User bubbles keep it so multi-line prompts stay readable.
      whiteSpace: role === "user" ? "pre-wrap" : "normal",
      wordBreak: "break-word",
      fontSize: "13px",
      lineHeight: "1.5",
      background: role === "user" ? "#0f0f0f" : "#fff",
      color: role === "user" ? "#fff" : "#0f0f0f",
      border: role === "user" ? "none" : "1px solid #e5e5e5",
      alignSelf: role === "user" ? "flex-end" : "flex-start",
      userSelect: "text",
      webkitUserSelect: "text",
    },
  });

  if (role === "user") {
    bubble.textContent = content;
  } else {
    // Always render assistant content as markdown. Segments live on the
    // message purely so the Terms tab can extract concept/name/book chips
    // — they aren't used to drive the bubble layout. (Mixing chips and
    // markdown inside one bubble is awkward; full markdown reads better
    // and the user can still drag any selection onto the canvas.)
    bubble.appendChild(renderMarkdownToFragment(content));
  }

  if (role === "assistant") {
    // Standard browser select-then-drag flow: the user selects text inside
    // the bubble (mousedown + drag = selection), then mousedown-on-selection
    // + drag dispatches HTML5 dragstart. Marking the bubble itself
    // `draggable="true"` would steal the first mousedown for a whole-bubble
    // drag and break selection — don't.
    bubble.title = "Select text and drag onto the canvas";
    bubble.addEventListener("dragstart", (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !bubble.contains(sel.anchorNode)) {
        e.preventDefault();
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/plain", text);
      e.dataTransfer.setData(
        DRAG_MIME,
        JSON.stringify({ sourceShapeIds, text }),
      );
      e.dataTransfer.effectAllowed = "copy";
    });

    // No enableTouchDrag here on purpose: iPad Safari (iOS 13+) dispatches
    // HTML5 dragstart natively when the user drags a text selection, so the
    // dragstart handler above already covers touch. Wiring a second pointer-
    // based drag would race the native one and double-paste on the canvas.
  }

  return bubble;
}
