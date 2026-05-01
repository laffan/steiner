// Left-anchored panel mirroring the shelf. Lists every chat in the active
// session (across all source shapes) plus session-wide transcripts you drop
// in. Click a chat header to focus its source shape on the canvas. Drop text
// anywhere on the panel to append a transcript.

import type { Segment, ShapeChat, TranscriptEntry } from "../api";
import { enableTouchDrag } from "./canvas-drag-touch";
import { h, clearChildren } from "./dom-helpers";
import { makeChatBubble, HIGHLIGHT_STYLE, TERM_KINDS } from "./chat-bubble";

const DRAG_MIME = "application/x-steiner-ask";

type TabId = "history" | "terms";
type TermKind = "concept" | "name" | "book";
type TermFilter = "all" | TermKind;

interface Term {
  kind: TermKind;
  text: string;
  /** Paired definition emitted directly after the term, if any. */
  definition?: string;
  sourceShapeId: string;
  /** Snapshot of the source shape's text, used when the shape no longer
   *  exists on the canvas. */
  sourceText?: string;
  chatId: string;
  firstSeen: string;
}

const PANEL_WIDTH_KEY = "steiner.chatPanelWidth";
const PANEL_MIN_WIDTH = 220;
const PANEL_MAX_WIDTH = 640;
const PANEL_DEFAULT_WIDTH = 320;

function readSavedWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return PANEL_DEFAULT_WIDTH;
    return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, n));
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

interface ChatRecord {
  shapeId: string;
  chat: ShapeChat;
}

export interface ChatPanelOptions {
  getShapeChats: () => Record<string, ShapeChat[]>;
  getTranscripts: () => TranscriptEntry[];
  getShapeText: (shapeId: string) => string;
  onAddTranscript: (text: string) => void;
  onDeleteTranscript: (id: string) => void;
  onDeleteChat: (shapeId: string, chatId: string) => void;
  onFocusShape: (id: string) => void;
}

export function createChatHistoryPanel(opts: ChatPanelOptions) {
  let isOpen = false;
  let openWidth = readSavedWidth();
  let activeTab: TabId = "history";
  let termFilter: TermFilter = "all";
  const expanded = new Set<string>(); // ids of items rendered open

  const panel = h("div", {
    style: {
      position: "absolute",
      top: "calc(env(safe-area-inset-top) + 20px)",
      left: "env(safe-area-inset-left)",
      bottom: "calc(env(safe-area-inset-bottom) + 20px)",
      zIndex: "150",
      display: "flex",
      flexDirection: "column",
      transition: "width 0.2s",
      overflow: "hidden",
      width: "24px",
      minWidth: "24px",
      borderRadius: "0 12px 12px 0",
      background: "rgba(255, 255, 255, 0.96)",
      border: "1px solid rgba(0, 0, 0, 0.08)",
      borderLeft: "none",
    },
    attrs: { "data-steiner-drop": "transcript" },
  });

  const grip = h("button", {
    text: "›",
    style: {
      width: "24px",
      height: "100%",
      position: "absolute",
      right: "0",
      top: "0",
      border: "none",
      borderRadius: "0 12px 12px 0",
      cursor: "pointer",
      fontSize: "14px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "10",
      background: "transparent",
      color: "#444",
    },
    onClick: () => { isOpen = !isOpen; rebuild(); },
  });
  panel.appendChild(grip);

  const content = h("div", {
    style: {
      marginRight: "24px",
      flex: "1",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      padding: "20px 0 20px 20px",
    },
  });
  panel.appendChild(content);

  // Resize handle on the panel's RIGHT edge (the side facing the canvas).
  const resizer = h("div", {
    style: {
      position: "absolute",
      right: "24px",
      top: "0",
      width: "8px",
      height: "100%",
      cursor: "ew-resize",
      zIndex: "20",
      background: "transparent",
      display: "none",
    },
    title: "Drag to resize chat panel",
  });
  let resizeDrag: { startX: number; startW: number } | null = null;
  resizer.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 || !isOpen) return;
    e.preventDefault();
    resizeDrag = { startX: e.clientX, startW: openWidth };
    resizer.setPointerCapture(e.pointerId);
    document.body.style.cursor = "ew-resize";
  });
  resizer.addEventListener("pointermove", (e: PointerEvent) => {
    if (!resizeDrag) return;
    // Panel docks on the left; dragging RIGHT widens it.
    const dx = e.clientX - resizeDrag.startX;
    const next = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, resizeDrag.startW + dx));
    openWidth = next;
    panel.style.width = `${next}px`;
    panel.style.minWidth = `${next}px`;
  });
  const endResize = (e: PointerEvent) => {
    if (!resizeDrag) return;
    resizeDrag = null;
    try { resizer.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    document.body.style.cursor = "";
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(openWidth)); } catch { /* storage disabled */ }
  };
  resizer.addEventListener("pointerup", endResize);
  resizer.addEventListener("pointercancel", endResize);
  panel.appendChild(resizer);

  // --- Drop target for transcript text ---
  panel.addEventListener("dragenter", (e) => {
    if (!isOpen) return;
    if (!hasTextLikeDrag(e.dataTransfer)) return;
    e.preventDefault();
    panel.style.background = "rgba(232, 240, 254, 0.96)";
  });
  panel.addEventListener("dragleave", (e) => {
    // Only clear the highlight when leaving the panel entirely.
    if (e.target !== panel && panel.contains(e.target as Node)) return;
    panel.style.background = "rgba(255, 255, 255, 0.96)";
  });
  panel.addEventListener("dragover", (e) => {
    if (!hasTextLikeDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  panel.addEventListener("drop", (e) => {
    panel.style.background = "rgba(255, 255, 255, 0.96)";
    if (!isOpen) return;
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    const text = readDroppedText(e.dataTransfer);
    if (text && text.trim()) opts.onAddTranscript(text.trim());
  });

  function rebuild() {
    panel.style.width = isOpen ? `${openWidth}px` : "24px";
    panel.style.minWidth = isOpen ? `${openWidth}px` : "24px";
    grip.textContent = isOpen ? "‹" : "›";
    content.style.display = isOpen ? "flex" : "none";
    resizer.style.display = isOpen ? "block" : "none";
    if (!isOpen) return;

    clearChildren(content);
    content.appendChild(makeTabStrip());

    if (activeTab === "history") renderHistory();
    else renderTerms();
  }

  function makeTabStrip(): HTMLElement {
    const strip = h("div", {
      style: {
        display: "flex",
        gap: "0",
        borderBottom: "1px solid #e5e5e5",
        marginBottom: "8px",
      },
    });
    const tab = (id: TabId, label: string) => {
      const isActive = activeTab === id;
      return h("button", {
        style: {
          flex: "1",
          padding: "6px 4px",
          fontSize: "11px",
          fontWeight: "600",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          color: isActive ? "#111" : "#888",
          background: "transparent",
          border: "none",
          borderBottom: isActive ? "2px solid #111" : "2px solid transparent",
          cursor: "pointer",
          marginBottom: "-1px",
          fontFamily: "inherit",
        },
        children: [label],
        onClick: () => {
          activeTab = id;
          rebuild();
        },
      });
    };
    strip.appendChild(tab("history", "History"));
    strip.appendChild(tab("terms", "Terms"));
    return strip;
  }

  function renderHistory() {
    const list = h("div", {
      style: { flex: "1", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px", paddingRight: "8px" },
    });

    const allChats: ChatRecord[] = [];
    const chatMap = opts.getShapeChats();
    for (const [shapeId, chats] of Object.entries(chatMap)) {
      for (const c of chats) allChats.push({ shapeId, chat: c });
    }
    const transcripts = opts.getTranscripts().slice();

    if (allChats.length === 0 && transcripts.length === 0) {
      list.appendChild(
        h("div", {
          style: { padding: "16px", color: "#888", fontSize: "13px", textAlign: "center" },
          children: ["No chats yet. Drop text here to create a transcript."],
        }),
      );
      content.appendChild(list);
      return;
    }

    type Item =
      | { kind: "chat"; created_at: string; record: ChatRecord }
      | { kind: "transcript"; created_at: string; entry: TranscriptEntry };
    const items: Item[] = [];
    for (const r of allChats) items.push({ kind: "chat", created_at: r.chat.created_at, record: r });
    for (const t of transcripts) items.push({ kind: "transcript", created_at: t.created_at, entry: t });
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));

    for (const item of items) {
      if (item.kind === "chat") list.appendChild(makeChatRow(item.record));
      else list.appendChild(makeTranscriptRow(item.entry));
    }

    content.appendChild(list);
  }

  function renderTerms() {
    const terms = extractTerms(opts.getShapeChats());

    // Filter chips.
    const chips = h("div", {
      style: {
        display: "flex",
        gap: "6px",
        flexWrap: "wrap",
        padding: "0 0 10px 0",
      },
    });
    const counts = countByKind(terms);
    chips.appendChild(makeChip("all", `All ${terms.length}`, termFilter === "all", null));
    for (const k of TERM_KINDS) {
      const n = counts[k] || 0;
      if (n === 0) continue;
      chips.appendChild(makeChip(k, `${labelFor(k)} ${n}`, termFilter === k, k));
    }
    content.appendChild(chips);

    const list = h("div", {
      style: {
        flex: "1",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        paddingRight: "8px",
      },
    });

    const filtered = termFilter === "all" ? terms : terms.filter((t) => t.kind === termFilter);
    if (filtered.length === 0) {
      list.appendChild(
        h("div", {
          style: { padding: "16px", color: "#888", fontSize: "13px", textAlign: "center" },
          children: terms.length === 0
            ? ["No flagged terms yet. Ask Claude on a note to populate this."]
            : ["No terms match the current filter."],
        }),
      );
      content.appendChild(list);
      return;
    }

    for (const t of filtered) list.appendChild(makeTermRow(t));
    content.appendChild(list);
  }

  function makeChip(
    id: TermFilter,
    label: string,
    isActive: boolean,
    kind: TermKind | null,
  ): HTMLElement {
    const baseStyle: Partial<CSSStyleDeclaration> = {
      padding: "3px 9px",
      borderRadius: "10px",
      fontSize: "11px",
      cursor: "pointer",
      border: "1px solid transparent",
      fontFamily: "inherit",
    };
    let style: Partial<CSSStyleDeclaration>;
    if (kind) {
      style = {
        ...baseStyle,
        ...HIGHLIGHT_STYLE[kind],
        opacity: isActive ? "1" : "0.7",
        outline: isActive ? "1.5px solid rgba(0,0,0,0.3)" : "none",
      };
    } else {
      style = {
        ...baseStyle,
        background: isActive ? "#111" : "#eee",
        color: isActive ? "#fff" : "#444",
      };
    }
    return h("button", {
      style,
      children: [label],
      onClick: () => {
        termFilter = id;
        rebuild();
      },
    });
  }

  function makeTermRow(t: Term): HTMLElement {
    // Same fallback chain as makeChatRow: live text → snapshot → empty.
    const liveText = opts.getShapeText(t.sourceShapeId);
    const sourceText = liveText.trim() || (t.sourceText ?? "").trim();
    const sourcePreview = sourceText.slice(0, 40) || "(empty note)";
    const sourceExists = liveText.trim().length > 0;
    const dragText = t.definition
      ? `**${t.text}** : ${t.definition}`
      : t.text;

    const chip = h("span", {
      style: {
        ...HIGHLIGHT_STYLE[t.kind],
        padding: "2px 8px",
        borderRadius: "5px",
        cursor: "grab",
        fontSize: "13px",
        display: "inline-block",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      title: t.definition
        ? `Drag to canvas (with definition), or click to focus source (${sourcePreview})`
        : `Drag to canvas, or click to focus source (${sourcePreview})`,
    });
    chip.textContent = t.text;
    chip.setAttribute("draggable", "true");
    chip.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("text/plain", dragText);
      // Empty sourceShapeIds → input-handler skips the auto-edge. Sidebar
      // terms land as standalone shapes; chat-bubble drags still link back.
      e.dataTransfer.setData(
        DRAG_MIME,
        JSON.stringify({
          sourceShapeIds: [],
          text: dragText,
          kind: t.kind,
        }),
      );
      e.dataTransfer.effectAllowed = "copy";
    });
    // Touch fallback — iOS doesn't fire HTML5 drag for finger input.
    enableTouchDrag(chip, () => ({
      text: dragText,
      sourceShapeIds: [],
      kind: t.kind,
    }));
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (sourceExists) opts.onFocusShape(t.sourceShapeId);
    });

    const children: HTMLElement[] = [chip];

    if (t.definition) {
      children.push(
        h("div", {
          style: {
            fontSize: "12px",
            color: "#444",
            marginTop: "3px",
            lineHeight: "1.35",
          },
          children: [t.definition],
        }),
      );
    }

    children.push(
      h("div", {
        style: {
          fontSize: "10px",
          color: "#999",
          marginTop: "2px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
        children: [`from: ${sourcePreview}`],
      }),
    );

    return h("div", {
      style: {
        padding: "6px 8px",
        borderRadius: "6px",
        background: "#fff",
        border: "1px solid #eee",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      },
      children,
    });
  }

  function makeChatRow(r: ChatRecord): HTMLElement {
    // Prefer the live shape text (lets the user see edits propagate); fall
    // back to the snapshot captured at chat-creation time when the source
    // shape has been deleted.
    const liveText = opts.getShapeText(r.shapeId);
    const sourceText = liveText.trim() || (r.chat.source_text ?? "").trim();
    const sourcePreview = sourceText.slice(0, 60) || "(empty note)";
    const sourceExists = liveText.trim().length > 0;
    const open = expanded.has(r.chat.id);

    const headerLabel = h("button", {
      style: {
        flex: "1",
        textAlign: "left",
        background: "transparent",
        border: "none",
        cursor: sourceExists ? "pointer" : "default",
        padding: "0",
        // Dim the link styling once the source is gone — it's no longer a
        // jump target, just a header.
        color: sourceExists ? "#1a3d80" : "#555",
        fontSize: "12px",
        fontWeight: "500",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontFamily: "inherit",
      },
      title: sourceExists
        ? "Click to focus the source note on the canvas"
        : "Source note has been deleted",
      children: [`↦ ${sourcePreview}`],
      onClick: (e: Event) => {
        e.stopPropagation();
        if (sourceExists) opts.onFocusShape(r.shapeId);
      },
    });

    return makeCollapsibleItem({
      id: r.chat.id,
      headerLeft: headerLabel,
      timestamp: r.chat.created_at,
      open,
      onToggle: () => {
        if (expanded.has(r.chat.id)) expanded.delete(r.chat.id);
        else expanded.add(r.chat.id);
        rebuild();
      },
      onDelete: () => {
        if (!confirm("Delete this chat?")) return;
        opts.onDeleteChat(r.shapeId, r.chat.id);
      },
      buildBody: () => {
        const body = h("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "8px 10px 12px 10px",
            borderTop: "1px solid #eee",
            background: "#fff",
          },
        });
        // Skip user-role messages: the seed prompt just repeats the source
        // text shown in the row header, and there's no follow-up UI anymore
        // (the modal is gone). Only the assistant response carries new info.
        let hasAssistant = false;
        for (const m of r.chat.messages) {
          if (m.role !== "assistant") continue;
          hasAssistant = true;
          body.appendChild(
            makeChatBubble({
              role: m.role,
              content: m.content,
              segments: m.segments,
              sourceShapeIds: [r.shapeId],
              error: m.error,
            }),
          );
        }
        if (!hasAssistant) {
          body.appendChild(
            h("div", {
              style: {
                color: "#888",
                fontSize: "13px",
                fontStyle: "italic",
                padding: "4px 2px",
              },
              children: ["Asking Claude…"],
            }),
          );
        }
        return body;
      },
    });
  }

  function makeTranscriptRow(t: TranscriptEntry): HTMLElement {
    const preview = t.text.trim().slice(0, 80) || "(empty)";
    const open = expanded.has(t.id);

    const label = h("div", {
      style: {
        flex: "1",
        fontSize: "12px",
        color: "#444",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontStyle: "italic",
      },
      children: [`▤ ${preview}`],
    });

    return makeCollapsibleItem({
      id: t.id,
      headerLeft: label,
      timestamp: t.created_at,
      open,
      onToggle: () => {
        if (expanded.has(t.id)) expanded.delete(t.id);
        else expanded.add(t.id);
        rebuild();
      },
      onDelete: () => {
        if (!confirm("Delete this transcript?")) return;
        opts.onDeleteTranscript(t.id);
      },
      buildBody: () => {
        return h("div", {
          style: {
            padding: "8px 10px 12px 10px",
            borderTop: "1px solid #eee",
            background: "#fff",
            fontSize: "13px",
            lineHeight: "1.5",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "#1a1a1a",
            userSelect: "text",
            webkitUserSelect: "text",
          },
          children: [t.text],
        });
      },
    });
  }

  function makeCollapsibleItem(args: {
    id: string;
    headerLeft: HTMLElement;
    timestamp: string;
    open: boolean;
    onToggle: () => void;
    onDelete: () => void;
    buildBody: () => HTMLElement;
  }): HTMLElement {
    const wrap = h("div", {
      attrs: { "data-chat-id": args.id },
      style: {
        background: "#fff",
        border: "1px solid #e5e5e5",
        borderRadius: "8px",
        overflow: "hidden",
      },
    });

    const chevron = h("button", {
      style: {
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "#888",
        fontSize: "10px",
        padding: "0",
        width: "12px",
      },
      children: [args.open ? "▾" : "▸"],
      onClick: (e: Event) => {
        e.stopPropagation();
        args.onToggle();
      },
    });

    const time = h("span", {
      style: { fontSize: "10px", color: "#999", whiteSpace: "nowrap" },
      children: [formatTimestamp(args.timestamp)],
    });

    const del = h("button", {
      style: {
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "#a33",
        fontSize: "11px",
        padding: "0 4px",
        opacity: "0",
        transition: "opacity 0.1s",
      },
      title: "Delete",
      children: ["×"],
      onClick: (e: Event) => {
        e.stopPropagation();
        args.onDelete();
      },
    });

    const headerRow = h("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 10px",
        background: "#fafafa",
      },
      children: [chevron, args.headerLeft, time, del],
    });
    headerRow.addEventListener("mouseenter", () => (del.style.opacity = "1"));
    headerRow.addEventListener("mouseleave", () => (del.style.opacity = "0"));

    wrap.appendChild(headerRow);
    if (args.open) wrap.appendChild(args.buildBody());
    return wrap;
  }

  /** Open the panel, switch to History, expand the given chat, and scroll
   *  it into view. Used by the canvas's "Ask Claude" button to surface the
   *  newly-completed request without a separate modal. */
  function openExpanded(chatId: string) {
    isOpen = true;
    activeTab = "history";
    expanded.add(chatId);
    rebuild();
    // After rebuild, scroll the row into view. data-chat-id is set on the
    // collapsible item below.
    requestAnimationFrame(() => {
      const row = content.querySelector<HTMLElement>(
        `[data-chat-id="${cssEscape(chatId)}"]`,
      );
      if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  return { el: panel, rebuild, openExpanded };
}

function cssEscape(s: string): string {
  // Browsers ship CSS.escape; fall back to a permissive escape for the
  // characters our chat IDs actually contain (alphanumerics + _).
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function extractTerms(chatMap: Record<string, ShapeChat[]>): Term[] {
  // Dedupe by `${kind}:${lowercase(text)}` so the list isn't littered with
  // repeats. Keep the first-seen source so click-to-focus has a destination.
  // For each term, look ahead for an immediately-paired `definition`.
  const seen = new Map<string, Term>();
  for (const [shapeId, chats] of Object.entries(chatMap)) {
    for (const chat of chats) {
      for (const m of chat.messages) {
        if (m.role !== "assistant") continue;
        const segs: Segment[] | undefined = m.segments;
        if (!segs) continue;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          if (seg.kind !== "concept" && seg.kind !== "name" && seg.kind !== "book") {
            continue;
          }
          const text = seg.text.trim();
          if (!text) continue;
          const key = `${seg.kind}:${text.toLowerCase()}`;
          if (seen.has(key)) continue;
          const definition = pairedDefinition(segs, i);
          seen.set(key, {
            kind: seg.kind,
            text,
            definition,
            sourceShapeId: shapeId,
            sourceText: chat.source_text,
            chatId: chat.id,
            firstSeen: chat.created_at,
          });
        }
      }
    }
  }
  // Newest first; ties broken alphabetically by text.
  return [...seen.values()].sort((a, b) => {
    const c = b.firstSeen.localeCompare(a.firstSeen);
    return c !== 0 ? c : a.text.localeCompare(b.text);
  });
}

function pairedDefinition(segs: Segment[], termIndex: number): string | undefined {
  // Walk forward, skipping connector text segments (": ", " — ", etc.).
  for (let j = termIndex + 1; j < segs.length; j++) {
    const next = segs[j];
    if (next.kind === "text") {
      if (/^[\s:\-—–,.;]*$/.test(next.text)) continue;
      return undefined;
    }
    if (next.kind === "definition") {
      const t = next.text.trim();
      return t || undefined;
    }
    return undefined;
  }
  return undefined;
}

function countByKind(terms: Term[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of terms) out[t.kind] = (out[t.kind] || 0) + 1;
  return out;
}

function labelFor(kind: TermKind): string {
  if (kind === "concept") return "Concepts";
  if (kind === "name") return "Names";
  return "Books";
}

function readDroppedText(dt: DataTransfer): string {
  const types = ["text/plain", "text", "Text"];
  for (const t of types) {
    try {
      const v = dt.getData(t);
      if (v) return v;
    } catch {
      // ignore
    }
  }
  return "";
}

function hasTextLikeDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.some((t) => t === "text/plain" || t === "Text" || t === "text" || t.startsWith("text/"));
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const ms = now - d.getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}
