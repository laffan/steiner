import { api } from "../api";
import { h } from "./dom-helpers";

const STORAGE_WIDTH = "steiner.sidebar.width";
const STORAGE_COLLAPSED = "steiner.sidebar.collapsed";
const STORAGE_TAB = "steiner.sidebar.tab";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

export type SidebarTab = "sessions" | "chat";

interface Options {
  /** The Sessions tab body (built by createSessionsSidebar). */
  sessionsContent: HTMLElement;
  /** True on desktop. iOS hides the Chat tab and never shows the webview. */
  desktop: boolean;
  /** Called when the sidebar's geometry (width, collapsed, tab) changes. */
  onLayoutChange: () => void;
}

export interface Sidebar {
  el: HTMLElement;
  /** Toggle button placed in the top-right of the canvas area. */
  toggleEl: HTMLElement;
  /** True when the sidebar is fully collapsed (width 0). */
  isCollapsed(): boolean;
  /** Currently active tab. */
  activeTab(): SidebarTab;
  /** Logical-pixel rect of the chat content area inside the window, or null
   *  when the chat pane is not visible (collapsed, on Sessions tab, or iOS). */
  chatRect(): { x: number; y: number; w: number; h: number } | null;
}

export function createSidebar(opts: Options): Sidebar {
  let width = readNum(STORAGE_WIDTH, DEFAULT_WIDTH);
  width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
  let collapsed = readBool(STORAGE_COLLAPSED, false);
  let tab: SidebarTab = (localStorage.getItem(STORAGE_TAB) as SidebarTab) || "sessions";
  if (!opts.desktop) tab = "sessions";

  const chatHost = h("div", {
    style: {
      flex: "1",
      minHeight: "0",
      background: "#fafafa",
      display: tab === "chat" ? "block" : "none",
      // The actual claude.ai webview is a native child webview positioned
      // over this div by the Rust backend. The placeholder is here so the
      // rest of the layout reserves the right space and we can read the
      // host's bounding rect to tell Rust where to put the webview.
      position: "relative",
    },
  });

  // Make sessions content track tab visibility too.
  opts.sessionsContent.style.display = tab === "sessions" ? "flex" : "none";

  const tabBtn = (label: string, key: SidebarTab): HTMLButtonElement =>
    h("button", {
      style: {
        flex: "1",
        padding: "10px 12px",
        border: "none",
        background: "transparent",
        color: "#444",
        fontSize: "13px",
        fontWeight: "500",
        cursor: "pointer",
        borderTop: "2px solid transparent",
        borderRadius: "0",
      },
      children: [label],
      onClick: () => setTab(key),
    }) as HTMLButtonElement;

  const sessionsTab = tabBtn("Sessions", "sessions");
  const chatTab = tabBtn("Chat", "chat");
  if (!opts.desktop) chatTab.style.display = "none";

  const tabs = h("div", {
    style: {
      // Mobile only has the Sessions tab so the bar would be a meaningless
      // single button — hide the whole strip there.
      display: opts.desktop ? "flex" : "none",
      borderTop: "1px solid #e5e5e5",
      background: "#f0f0f0",
    },
    children: [sessionsTab, chatTab],
  });

  const body = h("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      flex: "1",
      minHeight: "0",
    },
    children: [opts.sessionsContent, chatHost],
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
    children: [body, tabs, resizeHandle],
  });

  const toggleEl = h("button", {
    style: {
      position: "fixed",
      top: "12px",
      // Clear the canvas's right-edge shelf grip (24px wide flush right)
      // by inset of ~44px so the two controls don't overlap.
      right: "44px",
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

  function renderToggleIcon() {
    // Show a left-pointing arrow when expanded (click to collapse), right
    // when collapsed.
    toggleEl.textContent = collapsed ? "›" : "‹";
  }

  function styleTabs() {
    for (const [btn, key] of [
      [sessionsTab, "sessions"],
      [chatTab, "chat"],
    ] as [HTMLButtonElement, SidebarTab][]) {
      const active = key === tab;
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
  }

  function setCollapsed(next: boolean) {
    collapsed = next;
    localStorage.setItem(STORAGE_COLLAPSED, next ? "1" : "0");
    applyWidth();
    opts.onLayoutChange();
  }

  function setTab(next: SidebarTab) {
    if (!opts.desktop && next === "chat") return;
    tab = next;
    localStorage.setItem(STORAGE_TAB, next);
    opts.sessionsContent.style.display = next === "sessions" ? "flex" : "none";
    chatHost.style.display = next === "chat" ? "block" : "none";
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

  function chatRect(): { x: number; y: number; w: number; h: number } | null {
    if (!opts.desktop || collapsed || tab !== "chat") return null;
    const r = chatHost.getBoundingClientRect();
    // Leave ~4px on the right so the resize handle stays clickable above the
    // native webview.
    const w = Math.max(0, r.width - 4);
    if (w <= 0 || r.height <= 0) return null;
    return { x: r.left, y: r.top, w, h: r.height };
  }

  return {
    el: aside,
    toggleEl,
    isCollapsed: () => collapsed,
    activeTab: () => tab,
    chatRect,
  };
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

let chatVisible = false;

export async function syncChatWebview(rect: ReturnType<Sidebar["chatRect"]>): Promise<void> {
  if (!rect) {
    if (chatVisible) {
      chatVisible = false;
      try {
        await api.hideChatWebview();
      } catch (e) {
        console.warn("[steiner] hideChatWebview failed", e);
      }
    }
    return;
  }
  try {
    await api.showChatWebview(rect.x, rect.y, rect.w, rect.h);
    chatVisible = true;
  } catch (e) {
    console.warn("[steiner] showChatWebview failed", e);
  }
}
