import "./index.css";
import { listen } from "@tauri-apps/api/event";
import { api, DEFAULT_MODEL, type Session, type ShapeChat, type TranscriptEntry } from "./api";
import { createSessionsSidebar } from "./ui/sessions-sidebar";
import { createSettingsModal } from "./ui/settings-modal";
import { createCanvasHost, type CanvasSnapshot } from "./ui/canvas-host";
import { createAskModal } from "./ui/ask-modal";
import { createChatHistoryPanel } from "./ui/chat-history-panel";
import { showExportModal } from "./ui/export-modal";
import { createSidebar, syncChatWebview } from "./ui/sidebar";
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
    onLayoutChange: () => scheduleChatSync(),
  });

  const settings = createSettingsModal();

  const canvasHost = createCanvasHost({
    onChange: async (snap) => {
      if (!activeSession) return;
      await api.saveSessionCanvas(activeSession.id, snapToBackend(snap, shapeChats, transcripts));
    },
  });

  const askModal = createAskModal({
    onChatComplete: (sourceShapeIds, chatId, messages) => {
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
      // Persist immediately so chats survive crashes/reloads even before the
      // next debounced canvas save fires.
      void persistCurrentCanvas();
      chatPanel.rebuild();
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
  document.body.appendChild(askModal.el);

  // Reposition / show / hide the native claude.ai child webview whenever the
  // sidebar layout, the active tab, or the window itself changes. The
  // requestAnimationFrame coalesces bursts (resize drags, etc.).
  let chatSyncPending = false;
  function scheduleChatSync() {
    if (chatSyncPending) return;
    chatSyncPending = true;
    requestAnimationFrame(() => {
      chatSyncPending = false;
      void syncChatWebview(sidebar.chatRect());
    });
  }
  window.addEventListener("resize", scheduleChatSync);
  // Rust emits this after it relayouts the canvas webview on window resize.
  void listen("window-resized", () => scheduleChatSync());
  // Initial placement after the layout has been measured.
  scheduleChatSync();

  // Hook the canvas selection toolbar reaches via `window`.
  const w = window as unknown as {
    steinerAskClaude?: (ids: string[], text: string) => void;
  };
  w.steinerAskClaude = (ids, text) => askModal.open({ sourceShapeIds: ids, seedText: text });

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

  // Flush any pending canvas save when the window/tab is hidden.
  window.addEventListener("beforeunload", () => canvasHost.flushPendingSave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") canvasHost.flushPendingSave();
  });

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
