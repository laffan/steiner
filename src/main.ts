import "./index.css";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  DEFAULT_ASK_WORD_LIMIT,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_PREFIX,
  DEFAULT_PROMPT_SUFFIX,
  type ChatMessage,
  type Segment,
  type Session,
  type ShapeChat,
  type TranscriptEntry,
} from "./api";
import { createSessionsSidebar } from "./ui/sessions-sidebar";
import { createSettingsModal } from "./ui/settings-modal";
import { createCanvasHost, type CanvasSnapshot } from "./ui/canvas-host";
import { createChatHistoryPanel } from "./ui/chat-history-panel";
import { showExportModal } from "./ui/export-modal";
import { createSidebar, syncBrowserWebview } from "./ui/sidebar";
import { h } from "./ui/dom-helpers";

type ShapeChats = Record<string, ShapeChat[]>;

async function boot() {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";

  let activeSession: Session | null = null;
  let shapeChats: ShapeChats = {};
  let transcripts: TranscriptEntry[] = [];

  const sessions = createSessionsSidebar({
    onSelect: (id) => loadSession(id),
    onCreate: async () => {
      await persistCurrentCanvas();
      const s = await api.createSession(undefined, DEFAULT_MODEL);
      adoptSession(s);
      await sessions.reload();
    },
    onOpenSettings: () => settings.open(() => sessions.refreshSettings()),
    onExportPdf: (id) => exportSessionPdf(id),
    getActiveId: () => activeSession?.id || null,
  });

  // Probe the platform once so the sidebar can decide whether to surface the
  // Chat tab. Falls back to "desktop" if the call fails — better to expose
  // the feature than to silently strip it.
  let isDesktop = true;
  try {
    isDesktop = await api.isDesktop();
  } catch {
    isDesktop = true;
  }

  const sidebar = createSidebar({
    sessionsContent: sessions.el,
    desktop: isDesktop,
    onLayoutChange: () => scheduleBrowserSync(),
  });

  const settings = createSettingsModal();

  const canvasHost = createCanvasHost({
    onChange: async (snap) => {
      if (!activeSession) return;
      await api.saveSessionCanvas(activeSession.id, snapToBackend(snap, shapeChats, transcripts));
    },
  });

  const chatPanel = createChatHistoryPanel({
    getShapeChats: () => shapeChats,
    getTranscripts: () => transcripts,
    getShapeText: (id) => {
      const s = canvasHost.findShape(id);
      return s && s.type === "text" ? (s as { text: string }).text : "";
    },
    onAddTranscript: (text) => {
      const entry: TranscriptEntry = {
        id: `tr_${Math.random().toString(36).slice(2)}_${Date.now()}`,
        created_at: new Date().toISOString(),
        text,
      };
      transcripts = [entry, ...transcripts];
      void persistCurrentCanvas();
      chatPanel.rebuild();
    },
    onDeleteTranscript: (id) => {
      transcripts = transcripts.filter((t) => t.id !== id);
      void persistCurrentCanvas();
      chatPanel.rebuild();
    },
    onDeleteChat: (shapeId, chatId) => {
      const list = shapeChats[shapeId];
      if (!list) return;
      const next = list.filter((c) => c.id !== chatId);
      if (next.length > 0) shapeChats[shapeId] = next;
      else delete shapeChats[shapeId];
      void persistCurrentCanvas();
      chatPanel.rebuild();
    },
    onFocusShape: (id) => {
      canvasHost.focusShape(id);
    },
  });

  // Mount the chat panel as a child of the canvas stage so it overlays the
  // canvas and respects its bounds (just like the shelf).
  canvasHost.el.appendChild(chatPanel.el);

  const layout = h("div", {
    style: {
      display: "flex",
      width: "100%",
      height: "100%",
      flexDirection: "row",
      position: "relative",
    },
    children: [sidebar.el, canvasHost.el],
  });

  root.appendChild(layout);
  // The collapse toggle floats over the canvas in the upper-right corner so
  // it remains reachable whether the sidebar is open or collapsed.
  document.body.appendChild(sidebar.toggleEl);
  document.body.appendChild(settings.el);

  // Reposition / show / hide the active browser child webview (Chat or
  // Wikipedia) whenever the sidebar layout, the active tab, or the window
  // itself changes. requestAnimationFrame coalesces bursts (resize drags).
  let browserSyncPending = false;
  function scheduleBrowserSync() {
    if (browserSyncPending) return;
    browserSyncPending = true;
    requestAnimationFrame(() => {
      browserSyncPending = false;
      void syncBrowserWebview(sidebar.browserRect());
    });
  }
  window.addEventListener("resize", scheduleBrowserSync);
  // Rust emits this after it relayouts the canvas webview on window resize.
  void listen("window-resized", () => scheduleBrowserSync());
  // Initial placement after the layout has been measured.
  scheduleBrowserSync();

  // Hook the canvas selection toolbar reaches via `window`. The canvas
  // "Ask Claude" button used to open a draggable modal; now the request
  // runs silently in the background and the chat-history panel pops open
  // with the new chat already expanded once the response arrives.
  const w = window as unknown as {
    steinerAskClaude?: (ids: string[], text: string) => void;
  };
  w.steinerAskClaude = (ids, text) => {
    void runAskClaude(ids, text);
  };

  await sessions.reload();
  await sessions.refreshSettings();

  // Auto-select most recent session, or create one if none exist.
  const metas = await api.listSessions();
  if (metas.length > 0) {
    await loadSession(metas[0].id);
  } else {
    const s = await api.createSession(undefined, DEFAULT_MODEL);
    adoptSession(s);
    await sessions.reload();
  }

  await listen<string>("session-updated", () => {
    sessions.reload();
  });

  // Native Edit > Undo / Redo menu items emit these events instead of
  // dispatching the system "undo:" command (which goes to the WKWebView's
  // text-field undo manager, not our canvas). Fall back to the JS keydown
  // handler is unaffected for non-macOS contexts.
  void listen("menu:undo", () => canvasHost.undo());
  void listen("menu:redo", () => canvasHost.redo());

  // Flush any pending canvas save when the window/tab is hidden.
  window.addEventListener("beforeunload", () => canvasHost.flushPendingSave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") canvasHost.flushPendingSave();
  });

  async function runAskClaude(sourceShapeIds: string[], seedText: string) {
    if (!activeSession) return;
    const seed = seedText.trim().slice(0, 4000);
    if (!seed) return;

    let wordLimit = DEFAULT_ASK_WORD_LIMIT;
    let modelId: string = DEFAULT_MODEL;
    let prefix = DEFAULT_PROMPT_PREFIX;
    let suffix = DEFAULT_PROMPT_SUFFIX;
    try {
      const s = await api.getSettings();
      wordLimit = s.ask_word_limit ?? DEFAULT_ASK_WORD_LIMIT;
      modelId = s.ask_model || DEFAULT_MODEL;
      prefix = s.ask_prompt_prefix ?? DEFAULT_PROMPT_PREFIX;
      suffix = s.ask_prompt_suffix ?? DEFAULT_PROMPT_SUFFIX;
    } catch {
      // Use defaults — most likely the user hasn't set anything yet.
    }

    // Format: `[prefix] [term][suffix]. [word limit request]`. The period
    // is hardcoded so the suffix doesn't have to end one. Empty prefix/
    // suffix collapse cleanly (no double-space, no leading punctuation).
    const left = prefix ? `${prefix} ` : "";
    const wordLimitRequest = `I'd like your response to be ${wordLimit} words or less.`;
    const userPrompt = `${left}${seed}${suffix}. ${wordLimitRequest}`;
    const messages: ChatMessage[] = [{ role: "user", content: userPrompt }];

    const requestId = `ask_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const chatId = `chat_${Math.random().toString(36).slice(2)}_${Date.now()}`;

    // Commit a pending chat (just the user prompt) immediately so the
    // history list shows the term with an "Asking Claude…" status while
    // we wait. The same chatId is replaced when ask-done lands.
    commitChat(sourceShapeIds, chatId, messages.slice());
    chatPanel.openExpanded(chatId);

    // One-shot listeners: detach as soon as ask-done or ask-error fires for
    // this request. Chained on `currentRequest` so a stale listener can't
    // commit a previous run's response.
    const unlisteners: (() => void)[] = [];
    const cleanup = () => {
      for (const u of unlisteners) u();
      unlisteners.length = 0;
    };

    try {
      const u1 = await listen<{
        request_id: string;
        text: string;
        segments: Segment[] | null;
      }>("ask-done", (e) => {
        if (e.payload.request_id !== requestId) return;
        cleanup();
        const segments = e.payload.segments || undefined;
        messages.push({
          role: "assistant",
          content: e.payload.text,
          segments,
        });
        commitChat(sourceShapeIds, chatId, messages.slice());
      });
      unlisteners.push(u1);

      const u2 = await listen<{ request_id: string; message: string }>(
        "ask-error",
        (e) => {
          if (e.payload.request_id !== requestId) return;
          cleanup();
          messages.push({
            role: "assistant",
            content: `[Error: ${e.payload.message}]`,
          });
          commitChat(sourceShapeIds, chatId, messages.slice());
        },
      );
      unlisteners.push(u2);

      await api.askClaudeStream(requestId, messages, modelId);
    } catch (err) {
      cleanup();
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Failed";
      messages.push({ role: "assistant", content: `[Error: ${msg}]` });
      commitChat(sourceShapeIds, chatId, messages.slice());
    }
  }

  function commitChat(sourceShapeIds: string[], chatId: string, messages: ChatMessage[]) {
    if (!activeSession) return;
    const now = new Date().toISOString();
    for (const shapeId of sourceShapeIds) {
      const list = shapeChats[shapeId] ? shapeChats[shapeId].slice() : [];
      const existing = list.findIndex((c) => c.id === chatId);
      const entry: ShapeChat = {
        id: chatId,
        created_at: existing >= 0 ? list[existing].created_at : now,
        messages: messages.slice(),
      };
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
      shapeChats[shapeId] = list;
    }
    void persistCurrentCanvas();
    chatPanel.openExpanded(chatId);
  }

  function adoptSession(s: Session) {
    activeSession = s;
    shapeChats = readShapeChats(s.canvas);
    transcripts = readTranscripts(s.canvas);
    canvasHost.load(snapFromBackend(s.canvas));
    sessions.render();
    chatPanel.rebuild();
  }

  async function persistCurrentCanvas() {
    if (!activeSession) return;
    canvasHost.flushPendingSave();
    const snap = canvasHost.snapshot();
    // Drop chat history for shapes that no longer exist on the canvas.
    const liveIds = new Set(snap.shapes.map((s) => s.id));
    for (const id of Object.keys(shapeChats)) {
      if (!liveIds.has(id)) delete shapeChats[id];
    }
    await api.saveSessionCanvas(activeSession.id, snapToBackend(snap, shapeChats, transcripts));
  }

  async function loadSession(id: string) {
    if (activeSession?.id === id) return;
    await persistCurrentCanvas();
    const s = await api.getSession(id);
    adoptSession(s);
  }

  async function exportSessionPdf(id: string) {
    // Switch to the target session so its canvas can be snapped.
    if (activeSession?.id !== id) {
      await loadSession(id);
    }
    if (!activeSession) return;
    const dataUrl = await canvasHost.snapToPng();
    if (!dataUrl) {
      alert("This session is empty — nothing to export.");
      return;
    }
    showExportModal({ title: activeSession.title || "Session", dataUrl });
  }
}

function snapFromBackend(canvas: Session["canvas"] | undefined | null): CanvasSnapshot | null {
  if (!canvas) return null;
  const c = canvas as { shapes?: unknown; flow_edges?: unknown };
  return {
    shapes: (c.shapes as CanvasSnapshot["shapes"]) || [],
    flow_edges: (c.flow_edges as CanvasSnapshot["flow_edges"]) || [],
  };
}

function readShapeChats(canvas: Session["canvas"] | undefined | null): ShapeChats {
  if (!canvas) return {};
  const raw = (canvas as { shape_chats?: unknown }).shape_chats;
  if (!raw || typeof raw !== "object") return {};
  const out: ShapeChats = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v as ShapeChat[];
  }
  return out;
}

function readTranscripts(canvas: Session["canvas"] | undefined | null): TranscriptEntry[] {
  if (!canvas) return [];
  const raw = (canvas as { transcripts?: unknown }).transcripts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is TranscriptEntry =>
      !!e && typeof e === "object" &&
      typeof (e as TranscriptEntry).id === "string" &&
      typeof (e as TranscriptEntry).text === "string",
  );
}

function snapToBackend(snap: CanvasSnapshot, chats: ShapeChats, transcripts: TranscriptEntry[]) {
  return {
    shapes: snap.shapes as unknown,
    flow_edges: snap.flow_edges as unknown,
    shape_chats: chats,
    transcripts,
  };
}

boot().catch((err) => {
  console.error("[steiner] boot failed", err);
});
