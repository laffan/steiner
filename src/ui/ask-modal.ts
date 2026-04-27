import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, DEFAULT_MODEL, DEFAULT_ASK_WORD_LIMIT, MODELS, type ChatMessage, type Segment } from "../api";
import { h } from "./dom-helpers";
import { makeChatBubble } from "./chat-bubble";

function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label || id;
}

function buildSeedPrompt(seed: string, limit: number): string {
  return `Can you summarize ${seed}? I'd like your response to be ${limit} words or less.`;
}

interface OpenArgs {
  sourceShapeIds: string[];
  seedText: string;
}

interface ModalOptions {
  onChatComplete: (
    sourceShapeIds: string[],
    chatId: string,
    messages: ChatMessage[],
  ) => void;
}

export function createAskModal(opts: ModalOptions) {
  let messages: ChatMessage[] = [];
  let sourceShapeIds: string[] = [];
  let chatId = "";
  let pendingRequestId: string | null = null;
  let streamingEl: HTMLElement | null = null;
  let wordLimit: number = DEFAULT_ASK_WORD_LIMIT;
  let modelId: string = DEFAULT_MODEL;

  const titleEl = h("div", {
    style: { fontSize: "13px", fontWeight: "600", color: "#111", flex: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    children: ["Ask Claude"],
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

  const messagesEl = h("div", {
    style: {
      flex: "1", overflowY: "auto", padding: "12px",
      display: "flex", flexDirection: "column", gap: "10px",
      background: "#fafafa", userSelect: "text", webkitUserSelect: "text",
    },
  });

  const composer = h("textarea", {
    attrs: { placeholder: "Follow up…" },
    style: {
      flex: "1", minHeight: "36px", maxHeight: "120px",
      padding: "8px 10px", border: "1px solid #ddd", borderRadius: "8px",
      resize: "none", fontSize: "13px", fontFamily: "inherit", outline: "none", background: "#fff",
    },
  }) as HTMLTextAreaElement;

  composer.addEventListener("input", () => {
    composer.style.height = "auto";
    composer.style.height = `${Math.min(120, composer.scrollHeight)}px`;
  });

  const sendBtn = h("button", {
    style: {
      padding: "8px 12px", border: "none",
      background: "#0f0f0f", color: "#fff",
      borderRadius: "8px", fontSize: "13px", fontWeight: "600", cursor: "pointer",
    },
    children: ["Send"],
  }) as HTMLButtonElement;

  composer.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendFollowup();
    }
  });
  sendBtn.addEventListener("click", () => sendFollowup());

  const composerRow = h("div", {
    style: { display: "flex", gap: "6px", alignItems: "flex-end", padding: "10px 12px", borderTop: "1px solid #eee", background: "#fff" },
    children: [composer, sendBtn],
  });

  const panel = h("div", {
    style: {
      position: "fixed",
      top: "60px",
      left: "60px",
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
    children: [header, messagesEl, composerRow],
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

  let unlistens: UnlistenFn[] = [];

  function renderBubble(m: ChatMessage): HTMLElement {
    return makeChatBubble({
      role: m.role,
      content: m.content,
      segments: m.segments,
      sourceShapeIds,
    });
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    for (const m of messages) {
      messagesEl.appendChild(renderBubble(m));
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function makeStreamingPlaceholder(): HTMLElement {
    return h("div", {
      style: {
        maxWidth: "100%",
        padding: "8px 12px",
        borderRadius: "12px",
        fontSize: "13px",
        lineHeight: "1.5",
        background: "#fff",
        color: "#888",
        border: "1px solid #e5e5e5",
        alignSelf: "flex-start",
        fontStyle: "italic",
      },
      children: ["Thinking…"],
    });
  }

  async function startStream() {
    const requestId = `ask_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    pendingRequestId = requestId;
    streamingEl = makeStreamingPlaceholder();
    messagesEl.appendChild(streamingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    sendBtn.disabled = true;
    composer.disabled = true;
    try {
      await api.askClaudeStream(requestId, messages, modelId);
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Failed";
      if (streamingEl) streamingEl.textContent = `[Error: ${msg}]`;
      pendingRequestId = null;
      streamingEl = null;
      sendBtn.disabled = false;
      composer.disabled = false;
    }
  }

  async function sendFollowup() {
    const text = composer.value.trim();
    if (!text || pendingRequestId) return;
    composer.value = "";
    composer.style.height = "auto";
    messages.push({ role: "user", content: text });
    renderMessages();
    await startStream();
  }

  async function open(args: OpenArgs) {
    sourceShapeIds = args.sourceShapeIds.slice();
    chatId = `chat_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const seed = args.seedText.trim().slice(0, 4000);
    const seedLabel = seed.length > 60 ? `${seed.slice(0, 60)}…` : seed;
    // Refresh settings each time the modal opens so changes (word limit,
    // model) take effect without an app restart.
    try {
      const s = await api.getSettings();
      wordLimit = s.ask_word_limit ?? DEFAULT_ASK_WORD_LIMIT;
      modelId = s.ask_model || DEFAULT_MODEL;
    } catch {
      wordLimit = DEFAULT_ASK_WORD_LIMIT;
      modelId = DEFAULT_MODEL;
    }
    titleEl.textContent = `Ask Claude (${modelLabel(modelId)}) · ${seedLabel}`;
    messages = [{ role: "user", content: buildSeedPrompt(seed, wordLimit) }];
    renderMessages();
    panel.style.display = "flex";

    if (unlistens.length === 0) {
      // Streaming deltas are JSON characters under structured output —
      // useless to render incrementally. Wait for ask-done with parsed
      // segments, then render the bubble in one shot.
      const u1 = await listen<{
        request_id: string;
        text: string;
        segments: Segment[] | null;
      }>("ask-done", (e) => {
        if (e.payload.request_id !== pendingRequestId) return;
        const segments = e.payload.segments || undefined;
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: e.payload.text,
          segments,
        };
        messages.push(assistantMsg);
        if (streamingEl && streamingEl.parentNode) {
          const real = renderBubble(assistantMsg);
          streamingEl.parentNode.replaceChild(real, streamingEl);
        } else {
          messagesEl.appendChild(renderBubble(assistantMsg));
        }
        pendingRequestId = null;
        streamingEl = null;
        sendBtn.disabled = false;
        composer.disabled = false;
        composer.focus();
        try {
          opts.onChatComplete(sourceShapeIds.slice(), chatId, messages.slice());
        } catch (err) {
          console.warn("[steiner] onChatComplete failed", err);
        }
      });
      const u2 = await listen<{ request_id: string; message: string }>("ask-error", (e) => {
        if (e.payload.request_id !== pendingRequestId) return;
        if (streamingEl) streamingEl.textContent = `[Error: ${e.payload.message}]`;
        pendingRequestId = null;
        streamingEl = null;
        sendBtn.disabled = false;
        composer.disabled = false;
      });
      unlistens = [u1, u2];
    }

    await startStream();
  }

  function close() {
    panel.style.display = "none";
    pendingRequestId = null;
    streamingEl = null;
    sendBtn.disabled = false;
    composer.disabled = false;
  }

  return { el: panel, open, close };
}
