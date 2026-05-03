import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./runtime";
import type { Camera } from "./types";
import { webBackend } from "./web-api";

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
  /** Marks an assistant message that represents a failure (API error, empty
   *  response, etc.) so the bubble renders as an error instead of silently
   *  showing nothing or a confusing markdown blob. */
  error?: boolean;
}

export interface ShapeChat {
  id: string;
  created_at: string;
  messages: ChatMessage[];
  /** Snapshot of the source shape's text at chat creation. Used by the
   *  history panel as a fallback header when the source shape no longer
   *  exists on the canvas (the row stops being click-to-focus but still
   *  shows what the chat was about). */
  source_text?: string;
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
  /** Persisted camera (pan + zoom) so refreshing or reopening restores the
   *  user's view. Undefined on legacy sessions; loader falls back to origin. */
  camera?: Camera;
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
  ask_prompt_prefix: string | null;
  ask_prompt_suffix: string | null;
  dropbox_access_token: string | null;
  dropbox_refresh_token: string | null;
  dropbox_account_email: string | null;
  dropbox_last_sync: string | null;
  last_claude_url: string | null;
  last_wiki_url: string | null;
}

export const DEFAULT_PROMPT_PREFIX = "Can you summarize";
export const DEFAULT_PROMPT_SUFFIX = "";

/** Sidebar browser kinds — must match BROWSERS table in src-tauri/src/lib.rs. */
export type BrowserKind = "chat" | "wiki";

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

/**
 * Backend surface shared by the Tauri and web builds. Keep this as the only
 * interface UI code talks to — anything that branches on IS_TAURI outside
 * of this file is a smell.
 */
export interface ApiBackend {
  getSettings(): Promise<Settings>;
  setApiKey(key: string): Promise<void>;
  setAskWordLimit(limit: number): Promise<void>;
  setAskModel(model: string): Promise<void>;
  setAskPromptPrefix(prefix: string): Promise<void>;
  setAskPromptSuffix(suffix: string): Promise<void>;
  isDesktop(): Promise<boolean>;
  showBrowserWebview(
    kind: BrowserKind,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<void>;
  hideBrowserWebview(kind: BrowserKind): Promise<void>;

  listSessions(): Promise<SessionMeta[]>;
  createSession(title?: string, model?: string): Promise<Session>;
  getSession(id: string): Promise<Session>;
  updateSessionTitle(id: string, title: string): Promise<void>;
  updateSessionModel(id: string, model: string): Promise<void>;
  setSessionArchived(id: string, archived: boolean): Promise<void>;
  saveSessionCanvas(id: string, canvas: CanvasState): Promise<void>;
  deleteSession(id: string): Promise<void>;
  exportSessionMarkdown(id: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  sendMessage(sessionId: string, content: string): Promise<string>;
  askClaudeStream(
    requestId: string,
    messages: { role: "user" | "assistant"; content: string }[],
    model?: string,
  ): Promise<void>;

  dropboxStatus(): Promise<DropboxStatus>;
  dropboxExchangeCode(
    code: string,
    codeVerifier: string,
    appKey: string,
    redirectUri: string,
  ): Promise<DropboxStatus>;
  dropboxDisconnect(): Promise<void>;
  dropboxSyncNow(appKey: string): Promise<SyncResult>;
}

const tauriBackend: ApiBackend = {
  getSettings: () => invoke<Settings>("get_settings"),
  setApiKey: (key) => invoke<void>("set_api_key", { key }),
  setAskWordLimit: (limit) => invoke<void>("set_ask_word_limit", { limit }),
  setAskModel: (model) => invoke<void>("set_ask_model", { model }),
  setAskPromptPrefix: (prefix) =>
    invoke<void>("set_ask_prompt_prefix", { prefix }),
  setAskPromptSuffix: (suffix) =>
    invoke<void>("set_ask_prompt_suffix", { suffix }),
  isDesktop: () => invoke<boolean>("is_desktop"),
  showBrowserWebview: (kind, x, y, w, h) =>
    invoke<void>("show_browser_webview", { kind, x, y, w, h }),
  hideBrowserWebview: (kind) => invoke<void>("hide_browser_webview", { kind }),

  listSessions: () => invoke<SessionMeta[]>("list_sessions"),
  createSession: (title, model) =>
    invoke<Session>("create_session", { title, model }),
  getSession: (id) => invoke<Session>("get_session", { id }),
  updateSessionTitle: (id, title) =>
    invoke<void>("update_session_title", { id, title }),
  updateSessionModel: (id, model) =>
    invoke<void>("update_session_model", { id, model }),
  setSessionArchived: (id, archived) =>
    invoke<void>("set_session_archived", { id, archived }),
  saveSessionCanvas: (id, canvas) =>
    invoke<void>("save_session_canvas", { id, canvas }),
  deleteSession: (id) => invoke<void>("delete_session", { id }),
  exportSessionMarkdown: (id) =>
    invoke<string>("export_session_markdown", { id }),
  writeTextFile: (path, contents) =>
    invoke<void>("write_text_file", { path, contents }),
  sendMessage: (sessionId, content) =>
    invoke<string>("send_message", { sessionId, content }),
  askClaudeStream: (requestId, messages, model) =>
    invoke<void>("ask_claude_stream", { requestId, messages, model }),

  dropboxStatus: () => invoke<DropboxStatus>("dropbox_status"),
  dropboxExchangeCode: (code, codeVerifier, appKey, redirectUri) =>
    invoke<DropboxStatus>("dropbox_exchange_code", {
      code,
      codeVerifier,
      appKey,
      redirectUri,
    }),
  dropboxDisconnect: () => invoke<void>("dropbox_disconnect"),
  dropboxSyncNow: (appKey) => invoke<SyncResult>("dropbox_sync_now", { appKey }),
};

export const api: ApiBackend = IS_TAURI ? tauriBackend : webBackend;

/** Where Dropbox sends the user after they approve the app. We default to an
 *  HTTPS bridge page (`oauth-callback.html`) hosted on GitHub Pages, which
 *  JS-navigates to the `steiner://auth/callback` custom scheme. The bridge
 *  is what makes the round-trip work on Android — Chrome there silently
 *  drops a server-side 302 to a custom-scheme URL, but honours a
 *  JS-initiated navigation following the user's "Allow" click. iOS and
 *  desktop work with either. Override with `VITE_DROPBOX_REDIRECT_URI` in
 *  `.env.local` for dev (e.g. `http://localhost:5174/oauth-callback.html`)
 *  or for self-hosted Pages. The exact value here must also be added as a
 *  redirect URI in your Dropbox app settings. */
export const DROPBOX_REDIRECT_URI: string =
  (import.meta.env?.VITE_DROPBOX_REDIRECT_URI as string | undefined) ||
  "https://laffan.github.io/steiner/oauth-callback.html";

/** Vite-injected build-time secrets. The user creates a Dropbox app and puts
 *  `VITE_DROPBOX_APP_KEY=…` in a local `.env` file. Web builds ignore this
 *  since the Sync tab is desktop-only. */
export const DROPBOX_APP_KEY: string = (import.meta.env?.VITE_DROPBOX_APP_KEY as string | undefined) || "";
