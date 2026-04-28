import type { Segment, SegmentKind } from "../api";
import { h } from "./dom-helpers";

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

/** Kinds the user can directly drag — definitions ride along with their term. */
export const TERM_KINDS: Exclude<SegmentKind, "text" | "definition">[] = ["concept", "name", "book"];

/** Backwards-compat alias used by older callers. */
export const HIGHLIGHT_KINDS = TERM_KINDS;

/**
 * Walk segments from `index` looking for the nearest non-text neighbor in the
 * given direction. Whitespace/punctuation-only `text` segments (e.g. " — ", ": ")
 * are skipped because the prompt allows them between a term and its definition.
 */
function neighborSegment(
  segments: Segment[],
  index: number,
  direction: 1 | -1,
): { segment: Segment; index: number } | null {
  let i = index + direction;
  while (i >= 0 && i < segments.length) {
    const seg = segments[i];
    if (seg.kind === "text") {
      // Skip if it's just connector punctuation/whitespace.
      if (/^[\s:\-—–,.;]*$/.test(seg.text)) {
        i += direction;
        continue;
      }
      return null;
    }
    return { segment: seg, index: i };
  }
  return null;
}

/**
 * Drag text for a segment, taking term↔definition pairing into account:
 *   - definition → "**preceding-term** : definition" if a paired term exists
 *   - term with following definition → "**term** : definition"
 *   - bare term or unpaired definition → just the segment text
 */
export function dragTextForSegment(segments: Segment[], index: number): string {
  const seg = segments[index];
  if (!seg) return "";
  if (seg.kind === "definition") {
    const prev = neighborSegment(segments, index, -1);
    if (prev && prev.segment.kind !== "text" && prev.segment.kind !== "definition") {
      return `**${prev.segment.text.trim()}** : ${seg.text.trim()}`;
    }
    return seg.text;
  }
  if (seg.kind === "concept" || seg.kind === "name" || seg.kind === "book") {
    const next = neighborSegment(segments, index, 1);
    if (next && next.segment.kind === "definition") {
      return `**${seg.text.trim()}** : ${next.segment.text.trim()}`;
    }
    return seg.text;
  }
  return seg.text;
}

interface BubbleArgs {
  role: "user" | "assistant";
  content: string;
  segments?: Segment[];
  sourceShapeIds: string[];
}

export function makeChatBubble(args: BubbleArgs): HTMLElement {
  const { role, content, segments, sourceShapeIds } = args;

  const bubble = h("div", {
    style: {
      maxWidth: "100%",
      padding: "8px 12px",
      borderRadius: "12px",
      whiteSpace: "pre-wrap",
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

  if (role === "user" || !segments || segments.length === 0) {
    bubble.textContent = content;
  } else {
    for (let i = 0; i < segments.length; i++) {
      bubble.appendChild(renderSegment(segments, i, sourceShapeIds));
    }
  }

  if (role === "assistant") {
    bubble.title = "Drag a highlighted phrase, or select text and drag";
    // Selection-drag fallback: dragstart fires on the bubble when the user
    // drags a text selection that doesn't originate inside a draggable span.
    bubble.addEventListener("dragstart", (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !bubble.contains(sel.anchorNode)) {
        e.preventDefault();
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
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
  }

  return bubble;
}

function renderSegment(
  segments: Segment[],
  index: number,
  sourceShapeIds: string[],
): HTMLElement | Text {
  const seg = segments[index];
  if (seg.kind === "text" || !HIGHLIGHT_STYLE[seg.kind as Exclude<SegmentKind, "text">]) {
    return document.createTextNode(seg.text);
  }
  const kind = seg.kind as Exclude<SegmentKind, "text">;
  const span = h("span", {
    style: {
      ...HIGHLIGHT_STYLE[kind],
      padding: "1px 4px",
      borderRadius: "4px",
      cursor: "grab",
    },
  });
  span.textContent = seg.text;
  span.setAttribute("draggable", "true");
  span.title = `Drag this ${kind} onto the canvas`;
  span.addEventListener("dragstart", (e: DragEvent) => {
    if (!e.dataTransfer) return;
    e.stopPropagation();
    // Default text is the term/definition pair (or just the segment text).
    let text = dragTextForSegment(segments, index);
    // A user text-selection drives whether the structured-response specials
    // (kind styling, auto-pair with definition) apply:
    //   - selection lives entirely inside this span → still a single-kind
    //     drag, but use the user's sub-phrase as the dragged text
    //   - selection spans past the span boundary → drop the kind/pair and
    //     send plain text only (the user is grabbing a multi-segment slice
    //     and shouldn't get the highlight color or attached definition)
    let attachKind = true;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode) {
      const startsHere = span.contains(sel.anchorNode);
      const endsHere = sel.focusNode ? span.contains(sel.focusNode) : false;
      const picked = sel.toString().trim();
      if (picked && (startsHere || endsHere)) {
        text = picked;
        if (!(startsHere && endsHere)) attachKind = false;
      }
    }
    e.dataTransfer.setData("text/plain", text);
    const payload: { sourceShapeIds: string[]; text: string; kind?: typeof kind } = {
      sourceShapeIds,
      text,
    };
    if (attachKind) payload.kind = kind;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  });
  return span;
}
