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
  Segment,
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

/**
 * With `tool_choice` forced to a specific tool, Claude is allowed to skip the
 * preceding `text` content block entirely and emit just the tool call. That
 * left users staring at empty chat bubbles. The system prompt makes the
 * answer-then-tool-call ordering explicit so a text block is reliably produced.
 */
const ASK_SYSTEM_PROMPT =
  "Answer the user's question in clear prose first. After your written answer, call the highlight_terms tool exactly once to mark the key concepts, names, and book/work titles in your answer. Never reply with only a tool call — the prose answer is required.";

/**
 * Tool that Claude calls alongside its answer to mark up key terms. We force
 * the call via tool_choice so the response always contains structured term
 * data; the answer text comes through as preceding text content blocks.
 *
 * The Terms tab in the chat panel reads `message.segments` to populate its
 * filter chips (concept / name / book). Without these tool inputs the Terms
 * tab stays empty on the web build.
 */
const HIGHLIGHT_TOOL = {
  name: "highlight_terms",
  description:
    "Identify the key terms in your answer that the user might want to drag onto their notebook canvas as separate nodes. Categorize each as a concept, a person's name, or a book title.",
  input_schema: {
    type: "object",
    properties: {
      concepts: {
        type: "array",
        items: { type: "string" },
        description:
          "Conceptual terms or ideas central to your answer (e.g. 'natural selection', 'general relativity').",
      },
      names: {
        type: "array",
        items: { type: "string" },
        description: "Names of people you mention (e.g. 'Albert Einstein').",
      },
      books: {
        type: "array",
        items: { type: "string" },
        description: "Book / paper titles you mention (e.g. 'The Origin of Species').",
      },
    },
    required: ["concepts", "names", "books"],
  },
};

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { concepts?: string[]; names?: string[]; books?: string[] };
}

/**
 * Build segment metadata from a (concept / name / book) classification. The
 * bubble doesn't render these as inline chips — see chat-bubble.ts; segments
 * exist purely so extractTerms() in chat-history-panel.ts can populate the
 * Terms tab. So we just emit one segment per term and skip the work of
 * splitting the response text around them.
 */
function buildTermSegments(input: {
  concepts?: string[];
  names?: string[];
  books?: string[];
}): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  const push = (kind: Segment["kind"], list?: string[]) => {
    if (!list) return;
    for (const t of list) {
      const trimmed = (t || "").trim();
      if (!trimmed) continue;
      const key = `${kind}:${trimmed.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, text: trimmed });
    }
  };
  push("concept", input.concepts);
  push("name", input.names);
  push("book", input.books);
  return out;
}

/**
 * Anthropic returns errors as `{ type: "error", error: { type, message } }`.
 * Pull out the human-readable `message` when present so users see "invalid
 * x-api-key" instead of a wall of JSON. Falls back to the raw body otherwise.
 */
function formatApiError(status: number, body: string): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; type?: string };
      };
      if (parsed.error?.message) {
        return `Anthropic API ${status}: ${parsed.error.message}`;
      }
    } catch {
      // Not JSON — fall through to raw text.
    }
  }
  return `Anthropic API ${status}${body ? `: ${body}` : ""}`;
}

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
        system: ASK_SYSTEM_PROMPT,
        tools: [HIGHLIGHT_TOOL],
        // Force the tool call so the response always carries term metadata.
        // The system prompt above makes the model produce a `text` block
        // first; if it doesn't, we surface that as an error below.
        tool_choice: { type: "tool", name: "highlight_terms" },
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(formatApiError(r.status, body));
    }
    const data = (await r.json()) as {
      content?: AnthropicContentBlock[];
      type?: string;
      error?: { message?: string; type?: string };
      stop_reason?: string;
    };
    // Anthropic occasionally returns an error envelope at HTTP 200 (rate
    // limit retries, certain overload conditions). Catch those before they
    // fall through as an empty text response.
    if (data.type === "error" || data.error) {
      const msg = data.error?.message || "Anthropic API returned an error envelope.";
      throw new Error(msg);
    }
    const blocks = data.content || [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim();
    const toolBlock = blocks.find(
      (b) => b.type === "tool_use" && b.name === "highlight_terms",
    );
    const segments = toolBlock?.input
      ? buildTermSegments(toolBlock.input)
      : null;
    if (!text) {
      // Empty text block means the model skipped the prose answer (e.g. went
      // straight to the tool call) or hit max_tokens before producing any
      // visible content. Either way the chat bubble would be blank — surface
      // it as an error so the user understands why.
      const reason = data.stop_reason
        ? ` (stop_reason: ${data.stop_reason})`
        : "";
      throw new Error(
        `Claude returned no text in its response${reason}. Try asking again.`,
      );
    }
    emit("ask-done", { request_id: requestId, text, segments });
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
