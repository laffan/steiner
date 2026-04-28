import { invoke } from "@tauri-apps/api/core";

/** A persisted message inside a top-level Session (currently not surfaced in UI). */
export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export type SegmentKind = "text" | "concept" | "definition" | "name" | "book";

export interface Segment {
  kind: SegmentKind;
  text: string;
}

/** A turn inside an Ask Claude conversation tied to a canvas text shape. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  segments?: Segment[];
}

export interface ShapeChat {
  id: string;
  created_at: string;
  messages: ChatMessage[];
}

export interface TranscriptEntry {
  id: string;
  created_at: string;
  text: string;
}

export interface CanvasState {
  shapes?: unknown;
  snippet_meta?: unknown;
  flow_edges?: unknown;
  shape_chats?: Record<string, ShapeChat[]>;
  transcripts?: TranscriptEntry[];
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string;
  messages: SessionMessage[];
  canvas: CanvasState;
}

export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string;
  archived: boolean;
}

export interface Settings {
  anthropic_api_key: string | null;
  ask_word_limit: number | null;
  ask_model: string | null;
  dropbox_access_token: string | null;
  dropbox_refresh_token: string | null;
  dropbox_account_email: string | null;
  dropbox_last_sync: string | null;
  last_claude_url: string | null;
}

export interface DropboxStatus {
  linked: boolean;
  account_email: string | null;
  last_sync: string | null;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  skipped: number;
}

export const DEFAULT_ASK_WORD_LIMIT = 100;

export const MODELS = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

export const DEFAULT_MODEL = "claude-opus-4-7";

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),
  setAskWordLimit: (limit: number) =>
    invoke<void>("set_ask_word_limit", { limit }),
  setAskModel: (model: string) => invoke<void>("set_ask_model", { model }),
  isDesktop: () => invoke<boolean>("is_desktop"),
  showChatWebview: (x: number, y: number, w: number, h: number) =>
    invoke<void>("show_chat_webview", { x, y, w, h }),
  hideChatWebview: () => invoke<void>("hide_chat_webview"),

  listSessions: () => invoke<SessionMeta[]>("list_sessions"),
  createSession: (title?: string, model?: string) =>
    invoke<Session>("create_session", { title, model }),
  getSession: (id: string) => invoke<Session>("get_session", { id }),
  updateSessionTitle: (id: string, title: string) =>
    invoke<void>("update_session_title", { id, title }),
  updateSessionModel: (id: string, model: string) =>
    invoke<void>("update_session_model", { id, model }),
  setSessionArchived: (id: string, archived: boolean) =>
    invoke<void>("set_session_archived", { id, archived }),
  saveSessionCanvas: (id: string, canvas: CanvasState) =>
    invoke<void>("save_session_canvas", { id, canvas }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  exportSessionMarkdown: (id: string) =>
    invoke<string>("export_session_markdown", { id }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  sendMessage: (sessionId: string, content: string) =>
    invoke<string>("send_message", { sessionId, content }),
  askClaudeStream: (
    requestId: string,
    messages: { role: "user" | "assistant"; content: string }[],
    model?: string,
  ) => invoke<void>("ask_claude_stream", { requestId, messages, model }),

  dropboxStatus: () => invoke<DropboxStatus>("dropbox_status"),
  dropboxExchangeCode: (
    code: string,
    codeVerifier: string,
    appKey: string,
    redirectUri: string,
  ) =>
    invoke<DropboxStatus>("dropbox_exchange_code", {
      code,
      codeVerifier,
      appKey,
      redirectUri,
    }),
  dropboxDisconnect: () => invoke<void>("dropbox_disconnect"),
  dropboxSyncNow: (appKey: string) =>
    invoke<SyncResult>("dropbox_sync_now", { appKey }),
};

export const DROPBOX_REDIRECT_URI = "steiner://auth/callback";

/** Vite-injected build-time secrets. The user creates a Dropbox app and puts
 *  `VITE_DROPBOX_APP_KEY=…` in a local `.env` file. */
export const DROPBOX_APP_KEY: string = (import.meta.env?.VITE_DROPBOX_APP_KEY as string | undefined) || "";
