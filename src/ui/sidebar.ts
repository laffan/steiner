import { api, type BrowserKind } from "../api";
import { h } from "./dom-helpers";

const STORAGE_WIDTH = "steiner.sidebar.width";
const STORAGE_COLLAPSED = "steiner.sidebar.collapsed";
const STORAGE_TAB = "steiner.sidebar.tab";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

export type SidebarTab = "sessions" | "chat" | "wiki";

const BROWSER_TABS: BrowserKind[] = ["chat", "wiki"];

interface TabSpec {
  key: SidebarTab;
  label: string;
  /** When set, this tab hosts a native browser webview managed by Rust. */
  browser?: BrowserKind;
}

const TABS: TabSpec[] = [
  { key: "sessions", label: "Sessions" },
  { key: "chat", label: "Chat", browser: "chat" },
  { key: "wiki", label: "Wikipedia", browser: "wiki" },
];

interface Options {
  /** The Sessions tab body (built by createSessionsSidebar). */
  sessionsContent: HTMLElement;
  /** True on desktop. iOS hides the browser tabs and never shows a webview. */
  desktop: boolean;
  /** Called when the sidebar's geometry (width, collapsed, tab) changes. */
  onLayoutChange: () => void;
}

export interface BrowserRect {
  kind: BrowserKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sidebar {
  el: HTMLElement;
  /** Toggle button placed to the right of the sidebar (or canvas left edge
   *  when collapsed). */
  toggleEl: HTMLElement;
  /** True when the sidebar is fully collapsed (width 0). */
  isCollapsed(): boolean;
  /** Currently active tab. */
  activeTab(): SidebarTab;
  /** Logical-pixel rect of the active browser tab's content area, or null
   *  when no browser tab is showing (collapsed, on Sessions tab, or iOS). */
  browserRect(): BrowserRect | null;
}

export function createSidebar(opts: Options): Sidebar {
  let width = readNum(STORAGE_WIDTH, DEFAULT_WIDTH);
  width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
  let collapsed = readBool(STORAGE_COLLAPSED, false);
  let tab: SidebarTab = (localStorage.getItem(STORAGE_TAB) as SidebarTab) || "sessions";
  if (!opts.desktop && tab !== "sessions") tab = "sessions";

  // One placeholder div per browser tab. The actual native webview is
  // positioned over the placeholder by the Rust backend; the placeholder
  // exists so we can read a bounding rect from layout.
  const browserHosts: Record<BrowserKind, HTMLElement> = {
    chat: makeBrowserHost(),
    wiki: makeBrowserHost(),
  };

  // Make sessions content track tab visibility too.
  opts.sessionsContent.style.display = tab === "sessions" ? "flex" : "none";
  for (const k of BROWSER_TABS) {
    browserHosts[k].style.display = tab === k ? "block" : "none";
  }

  const tabButtons: Record<SidebarTab, HTMLButtonElement> = {} as Record<
    SidebarTab,
    HTMLButtonElement
  >;
  const tabBar = h("div", {
    style: {
      // Mobile only has the Sessions tab, so the strip would just be a
      // single button — hide it entirely.
      display: opts.desktop ? "flex" : "none",
      borderTop: "1px solid #e5e5e5",
      background: "#f0f0f0",
    },
  });
  for (const spec of TABS) {
    const btn = h("button", {
      style: {
        flex: "1",
        padding: "10px 8px",
        border: "none",
        background: "transparent",
        color: "#444",
        fontSize: "12px",
        fontWeight: "500",
        cursor: "pointer",
        borderTop: "2px solid transparent",
        borderRadius: "0",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      children: [spec.label],
      onClick: () => setTab(spec.key),
    }) as HTMLButtonElement;
    if (!opts.desktop && spec.browser) btn.style.display = "none";
    tabButtons[spec.key] = btn;
    tabBar.appendChild(btn);
  }

  const body = h("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      flex: "1",
      minHeight: "0",
    },
    children: [opts.sessionsContent, browserHosts.chat, browserHosts.wiki],
  });

  const resizeHandle = h("div", {
    style: {
      position: "absolute",
      top: "0",
      right: "-3px",
      width: "6px",
      height: "100%",
      cursor: "col-resize",
      zIndex: "10",
      background: "transparent",
    },
    title: "Drag to resize",
  });

  const aside = h("aside", {
    style: {
      position: "relative",
      width: collapsed ? "0px" : `${width}px`,
      minWidth: collapsed ? "0px" : `${width}px`,
      borderRight: collapsed ? "none" : "1px solid #e5e5e5",
      background: "#fafafa",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      transition: "none",
    },
    children: [body, tabBar, resizeHandle],
  });

  const toggleEl = h("button", {
    style: {
      // Anchored to the sidebar's right edge so the browser webview (a
      // native view layered above the HTML) never covers it. When the
      // sidebar resizes or collapses, applyTogglePosition() updates `left`
      // to slide the toggle along with it.
      position: "fixed",
      top: "12px",
      left: "12px",
      width: "32px",
      height: "32px",
      border: "1px solid #ddd",
      background: "#fff",
      borderRadius: "8px",
      fontSize: "16px",
      lineHeight: "1",
      cursor: "pointer",
      zIndex: "200",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#333",
      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
    },
    title: "Toggle sidebar",
    onClick: () => setCollapsed(!collapsed),
  });
  renderToggleIcon();
  applyTogglePosition();

  function renderToggleIcon() {
    toggleEl.textContent = collapsed ? "›" : "‹";
  }

  function applyTogglePosition() {
    // Sit ~30px past the sidebar's right edge (or the canvas's left edge
    // when collapsed) so we clear the canvas-side chat-history-panel grip
    // (24px wide, flush left).
    const offset = collapsed ? 0 : width;
    toggleEl.style.left = `${offset + 30}px`;
  }

  function styleTabs() {
    for (const spec of TABS) {
      const btn = tabButtons[spec.key];
      const active = spec.key === tab;
      btn.style.background = active ? "#fafafa" : "transparent";
      btn.style.color = active ? "#0f0f0f" : "#666";
      btn.style.borderTop = active ? "2px solid #0f0f0f" : "2px solid transparent";
    }
  }
  styleTabs();

  function applyWidth() {
    aside.style.width = collapsed ? "0px" : `${width}px`;
    aside.style.minWidth = collapsed ? "0px" : `${width}px`;
    aside.style.borderRight = collapsed ? "none" : "1px solid #e5e5e5";
    renderToggleIcon();
    applyTogglePosition();
  }

  function setCollapsed(next: boolean) {
    collapsed = next;
    localStorage.setItem(STORAGE_COLLAPSED, next ? "1" : "0");
    applyWidth();
    opts.onLayoutChange();
  }

  function setTab(next: SidebarTab) {
    const spec = TABS.find((t) => t.key === next);
    if (!spec) return;
    if (!opts.desktop && spec.browser) return;
    tab = next;
    localStorage.setItem(STORAGE_TAB, next);
    opts.sessionsContent.style.display = next === "sessions" ? "flex" : "none";
    for (const k of BROWSER_TABS) {
      browserHosts[k].style.display = next === k ? "block" : "none";
    }
    styleTabs();
    opts.onLayoutChange();
  }

  // Resize drag.
  resizeHandle.addEventListener("pointerdown", (e) => {
    if (collapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    resizeHandle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (ev.clientX - startX)));
      width = next;
      applyWidth();
      opts.onLayoutChange();
    };
    const up = (ev: PointerEvent) => {
      resizeHandle.removeEventListener("pointermove", move);
      resizeHandle.removeEventListener("pointerup", up);
      try {
        resizeHandle.releasePointerCapture(ev.pointerId);
      } catch {
        // pointer already released
      }
      localStorage.setItem(STORAGE_WIDTH, String(width));
    };
    resizeHandle.addEventListener("pointermove", move);
    resizeHandle.addEventListener("pointerup", up);
  });

  function browserRect(): BrowserRect | null {
    if (!opts.desktop || collapsed) return null;
    const spec = TABS.find((t) => t.key === tab);
    if (!spec?.browser) return null;
    const host = browserHosts[spec.browser];
    const r = host.getBoundingClientRect();
    // Leave ~4px on the right so the sidebar resize handle stays clickable
    // above the native webview.
    const w = Math.max(0, r.width - 4);
    if (w <= 0 || r.height <= 0) return null;
    return { kind: spec.browser, x: r.left, y: r.top, w, h: r.height };
  }

  return {
    el: aside,
    toggleEl,
    isCollapsed: () => collapsed,
    activeTab: () => tab,
    browserRect,
  };
}

function makeBrowserHost(): HTMLElement {
  return h("div", {
    style: {
      flex: "1",
      minHeight: "0",
      background: "#fafafa",
      display: "none",
      position: "relative",
    },
  });
}

function readNum(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "1";
}

// Track which browser webviews are currently shown so we can call hide for
// the others when the user switches tabs (only one can overlay the sidebar
// at a time).
const visibleBrowsers = new Set<BrowserKind>();

export async function syncBrowserWebview(rect: BrowserRect | null): Promise<void> {
  // Hide every browser that isn't the currently-visible one.
  const keep: BrowserKind | null = rect?.kind ?? null;
  for (const kind of [...visibleBrowsers]) {
    if (kind === keep) continue;
    visibleBrowsers.delete(kind);
    try {
      await api.hideBrowserWebview(kind);
    } catch (e) {
      console.warn(`[steiner] hideBrowserWebview(${kind}) failed`, e);
    }
  }
  if (!rect) return;
  try {
    await api.showBrowserWebview(rect.kind, rect.x, rect.y, rect.w, rect.h);
    visibleBrowsers.add(rect.kind);
  } catch (e) {
    console.warn(`[steiner] showBrowserWebview(${rect.kind}) failed`, e);
  }
}
