/**
 * Web build of the api surface. Same shape as the Tauri backend in api.ts;
 * persistence is localStorage instead of the filesystem, Ask Claude calls the
 * Anthropic API directly with the user's stored key (no proxy server), and
 * desktop-only commands (browser webviews, Dropbox sync, file write) are
 * either no-ops or rejected with a clear error.
 *
 * Storage layout (single namespace under `steiner.web.`):
 *   steiner.web.settings           -> Settings JSON
 *   steiner.web.sessions.index     -> SessionMeta[]
 *   steiner.web.session.<id>       -> Session JSON
 *
 * Sessions are stored individually so a single canvas's growth doesn't bloat
 * every read of the index. localStorage is bounded (~5MB on most browsers);
 * if a session bumps against that we can move to IndexedDB later without
 * changing the api surface.
 */

import type {
  ApiBackend,
  CanvasState,
  ChatMessage,
  DropboxStatus,
  Session,
  SessionMeta,
  Settings,
  SyncResult,
} from "./api";
import { DEFAULT_MODEL } from "./api";
import { emit } from "./event-bus";

const KEY_SETTINGS = "steiner.web.settings";
const KEY_INDEX = "steiner.web.sessions.index";
const sessionKey = (id: string) => `steiner.web.session.${id}`;

const DEFAULT_SETTINGS: Settings = {
  anthropic_api_key: null,
  ask_word_limit: null,
  ask_model: null,
  ask_prompt_prefix: null,
  ask_prompt_suffix: null,
  dropbox_access_token: null,
  dropbox_refresh_token: null,
  dropbox_account_email: null,
  dropbox_last_sync: null,
  last_claude_url: null,
  last_wiki_url: null,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: Settings): void {
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
}

function patchSettings(patch: Partial<Settings>): void {
  saveSettings({ ...loadSettings(), ...patch });
}

function loadIndex(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(KEY_INDEX);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionMeta[]) : [];
  } catch {
    return [];
  }
}

function saveIndex(arr: SessionMeta[]): void {
  localStorage.setItem(KEY_INDEX, JSON.stringify(arr));
}

function loadSessionRecord(id: string): Session | null {
  try {
    const raw = localStorage.getItem(sessionKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function saveSessionRecord(s: Session): void {
  localStorage.setItem(sessionKey(s.id), JSON.stringify(s));
}

function deleteSessionRecord(id: string): void {
  localStorage.removeItem(sessionKey(id));
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function metaFromSession(s: Session, archived = false): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    created_at: s.created_at,
    updated_at: s.updated_at,
    model: s.model,
    archived,
  };
}

function updateIndexEntry(id: string, mut: (m: SessionMeta) => void): void {
  const idx = loadIndex();
  const i = idx.findIndex((m) => m.id === id);
  if (i < 0) return;
  mut(idx[i]);
  saveIndex(idx);
}

// --- Ask Claude (direct browser call to Anthropic) ---

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

async function askClaudeViaAnthropic(
  requestId: string,
  messages: ChatMessage[],
  model: string | undefined,
): Promise<void> {
  const settings = loadSettings();
  const apiKey = settings.anthropic_api_key;
  if (!apiKey) {
    emit("ask-error", {
      request_id: requestId,
      message: "No Anthropic API key set. Open Settings → General to add one.",
    });
    return;
  }

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // Required for browser-origin requests since 2024-08; otherwise the
        // API rejects the call with a 403 even with a valid key.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: 4096,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Anthropic API ${r.status}${body ? `: ${body}` : ""}`);
    }
    const data = (await r.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("");
    emit("ask-done", { request_id: requestId, text, segments: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit("ask-error", { request_id: requestId, message });
  }
}

const NOT_AVAILABLE = "This feature requires the desktop build of Steiner.";

export const webBackend: ApiBackend = {
  // --- Settings ---
  getSettings: async () => loadSettings(),
  setApiKey: async (key) => patchSettings({ anthropic_api_key: key || null }),
  setAskWordLimit: async (limit) => patchSettings({ ask_word_limit: limit }),
  setAskModel: async (model) => patchSettings({ ask_model: model }),
  setAskPromptPrefix: async (prefix) => patchSettings({ ask_prompt_prefix: prefix }),
  setAskPromptSuffix: async (suffix) => patchSettings({ ask_prompt_suffix: suffix }),

  // --- Platform / browser webviews ---
  // Web reports !isDesktop so the sidebar hides Chat / Wikipedia tabs (those
  // are native child webviews on desktop with no equivalent in the browser).
  isDesktop: async () => false,
  showBrowserWebview: async () => {
    /* no-op on web */
  },
  hideBrowserWebview: async () => {
    /* no-op on web */
  },

  // --- Sessions ---
  listSessions: async () => {
    const idx = loadIndex();
    // Newest first by updated_at; mirrors what the Rust backend returns.
    return idx
      .slice()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },

  createSession: async (title, model) => {
    const id = newId("s");
    const ts = nowIso();
    const session: Session = {
      id,
      title: title || "New session",
      created_at: ts,
      updated_at: ts,
      model: model || DEFAULT_MODEL,
      messages: [],
      canvas: {},
    };
    saveSessionRecord(session);
    const idx = loadIndex();
    idx.push(metaFromSession(session));
    saveIndex(idx);
    emit("session-updated", id);
    return session;
  },

  getSession: async (id) => {
    const s = loadSessionRecord(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return s;
  },

  updateSessionTitle: async (id, title) => {
    const s = loadSessionRecord(id);
    if (!s) return;
    s.title = title;
    s.updated_at = nowIso();
    saveSessionRecord(s);
    updateIndexEntry(id, (m) => {
      m.title = title;
      m.updated_at = s.updated_at;
    });
    emit("session-updated", id);
  },

  updateSessionModel: async (id, model) => {
    const s = loadSessionRecord(id);
    if (!s) return;
    s.model = model;
    s.updated_at = nowIso();
    saveSessionRecord(s);
    updateIndexEntry(id, (m) => {
      m.model = model;
      m.updated_at = s.updated_at;
    });
    emit("session-updated", id);
  },

  setSessionArchived: async (id, archived) => {
    updateIndexEntry(id, (m) => {
      m.archived = archived;
    });
    emit("session-updated", id);
  },

  saveSessionCanvas: async (id, canvas: CanvasState) => {
    const s = loadSessionRecord(id);
    if (!s) return;
    s.canvas = canvas;
    s.updated_at = nowIso();
    saveSessionRecord(s);
    updateIndexEntry(id, (m) => {
      m.updated_at = s.updated_at;
    });
  },

  deleteSession: async (id) => {
    deleteSessionRecord(id);
    saveIndex(loadIndex().filter((m) => m.id !== id));
    emit("session-updated", id);
  },

  exportSessionMarkdown: async (id) => {
    // Minimal markdown export — backend assembles richer output, but the web
    // build doesn't need feature parity here. Used only by the Sessions tab
    // export button as a fallback when the user picks "Markdown".
    const s = loadSessionRecord(id);
    if (!s) return "";
    const lines: string[] = [`# ${s.title}`, "", `_${s.created_at}_`, ""];
    for (const m of s.messages) {
      lines.push(`## ${m.role}`);
      lines.push("");
      lines.push(m.content);
      lines.push("");
    }
    return lines.join("\n");
  },

  // Web exports route through the browser download path in export-modal.ts
  // and never call this — but keep the shape so callers don't need to branch.
  writeTextFile: async () => {
    throw new Error(NOT_AVAILABLE);
  },

  sendMessage: async () => {
    // Top-level Session messages aren't surfaced in the current UI; if a
    // future feature uses them, web can mirror askClaudeViaAnthropic here.
    throw new Error(NOT_AVAILABLE);
  },

  askClaudeStream: async (requestId, messages, model) => {
    // Fire-and-forget — the Tauri version returns void as soon as the request
    // is queued and emits ask-done / ask-error later. Mirror that contract so
    // callers' listener wiring works unchanged.
    void askClaudeViaAnthropic(requestId, messages, model);
  },

  // --- Dropbox: desktop-only. Stub so settings UI doesn't crash, but the
  // tab itself is not mounted in the web build (see settings-modal.ts). ---
  dropboxStatus: async (): Promise<DropboxStatus> => ({
    linked: false,
    account_email: null,
    last_sync: null,
  }),
  dropboxExchangeCode: async (): Promise<DropboxStatus> => {
    throw new Error(NOT_AVAILABLE);
  },
  dropboxDisconnect: async () => {
    /* no-op */
  },
  dropboxSyncNow: async (): Promise<SyncResult> => {
    throw new Error(NOT_AVAILABLE);
  },
};
