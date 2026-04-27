import { h } from "./dom-helpers";
import type { ShapeChat } from "../api";
import { makeChatBubble } from "./chat-bubble";

interface OpenArgs {
  shapeId: string;
  shapeText: string;
  chats: ShapeChat[];
}

export function createHistoryModal() {
  let currentShapeId = "";

  const titleEl = h("div", {
    style: {
      fontSize: "13px", fontWeight: "600", color: "#111",
      flex: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    },
    children: ["Chat history"],
  });

  const closeBtn = h("button", {
    style: {
      width: "26px", height: "26px", border: "none", borderRadius: "6px",
      background: "transparent", color: "#666", cursor: "pointer", fontSize: "16px", lineHeight: "1",
    },
    children: ["×"],
    onClick: () => close(),
  });

  const header = h("div", {
    style: {
      display: "flex", alignItems: "center", gap: "8px",
      padding: "10px 12px", borderBottom: "1px solid #eee",
      cursor: "grab", userSelect: "none", webkitUserSelect: "none",
    },
    children: [titleEl, closeBtn],
  });

  const listEl = h("div", {
    style: {
      flex: "1", overflowY: "auto", padding: "12px",
      display: "flex", flexDirection: "column", gap: "10px",
      background: "#fafafa",
    },
  });

  const panel = h("div", {
    style: {
      position: "fixed",
      top: "100px",
      left: "100px",
      width: "440px",
      maxWidth: "calc(100vw - 320px)",
      height: "min(560px, 70vh)",
      background: "#fff",
      borderRadius: "12px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
      border: "1px solid #ddd",
      display: "none",
      flexDirection: "column",
      zIndex: "8000",
      overflow: "hidden",
    },
    children: [header, listEl],
  });

  // Drag the panel by its header.
  let dragOff: { x: number; y: number } | null = null;
  header.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = panel.getBoundingClientRect();
    dragOff = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    header.setPointerCapture(e.pointerId);
    header.style.cursor = "grabbing";
  });
  header.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragOff) return;
    const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dragOff.x));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOff.y));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragOff) return;
    dragOff = null;
    try { header.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    header.style.cursor = "grab";
  };
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);

  function makeChatItem(chat: ShapeChat, defaultOpen: boolean): HTMLElement {
    const firstUser = chat.messages.find((m) => m.role === "user");
    const summary = (firstUser?.content || "Conversation").slice(0, 80);
    const meta = formatTimestamp(chat.created_at);

    const messagesContainer = h("div", {
      style: {
        display: defaultOpen ? "flex" : "none",
        flexDirection: "column",
        gap: "8px",
        padding: "10px 10px 12px 10px",
        borderTop: "1px solid #eee",
        background: "#fff",
      },
    });
    for (const m of chat.messages) {
      messagesContainer.appendChild(
        makeChatBubble({
          role: m.role,
          content: m.content,
          segments: m.segments,
          sourceShapeIds: [currentShapeId],
        }),
      );
    }

    const headerRow = h("button", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        padding: "10px 12px",
        background: "#fff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      },
      onClick: () => {
        const open = messagesContainer.style.display !== "none";
        messagesContainer.style.display = open ? "none" : "flex";
        chevron.textContent = open ? "▸" : "▾";
      },
    });

    const chevron = h("span", {
      style: { color: "#888", fontSize: "10px", width: "10px" },
      children: [defaultOpen ? "▾" : "▸"],
    });

    const summaryEl = h("div", {
      style: {
        flex: "1",
        fontSize: "13px",
        color: "#111",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      children: [summary],
    });

    const metaEl = h("div", {
      style: { fontSize: "11px", color: "#888" },
      children: [meta],
    });

    headerRow.appendChild(chevron);
    headerRow.appendChild(summaryEl);
    headerRow.appendChild(metaEl);

    return h("div", {
      style: {
        background: "#fff",
        border: "1px solid #e5e5e5",
        borderRadius: "10px",
        overflow: "hidden",
      },
      children: [headerRow, messagesContainer],
    });
  }

  function open(args: OpenArgs) {
    currentShapeId = args.shapeId;
    const preview = args.shapeText.trim().slice(0, 60);
    titleEl.textContent = preview ? `Chat history · ${preview}` : "Chat history";

    listEl.innerHTML = "";
    if (!args.chats || args.chats.length === 0) {
      listEl.appendChild(
        h("div", {
          style: { padding: "24px", color: "#888", fontSize: "13px", textAlign: "center" },
          children: ["No previous chats for this note."],
        }),
      );
    } else {
      // Newest first; expand the most recent by default.
      const sorted = args.chats.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
      sorted.forEach((c, i) => listEl.appendChild(makeChatItem(c, i === 0)));
    }
    panel.style.display = "flex";
  }

  function close() {
    panel.style.display = "none";
  }

  return { el: panel, open, close };
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return "";
  }
}
