/**
 * Runtime target detection. Steiner has two builds from the same source tree:
 *
 * - Desktop (Tauri): exposes `window.__TAURI_INTERNALS__`, has IPC + native FS
 * - Web (GitHub Pages): pure browser, persistence via localStorage, no IPC
 *
 * `IS_TAURI` is the single source of truth — `api.ts` dispatches each call to
 * either the Tauri backend or the web backend based on this flag, and feature
 * UI (Sync tab, Chat / Wikipedia tabs) hides itself when false.
 */

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
}

export const IS_TAURI: boolean =
  typeof window !== "undefined" &&
  (window as unknown as TauriWindow).__TAURI_INTERNALS__ != null;

export const IS_WEB: boolean = !IS_TAURI;
