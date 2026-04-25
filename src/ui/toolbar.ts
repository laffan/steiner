import type { DrawingState } from "../state";
import type { Tool } from "../types";
import { h } from "./dom-helpers";
import { icon } from "./icons";
import { createBookmarksPanel } from "./bookmarks-panel";

interface ToolDef { iconName: string; label: string; tool: Tool | "brainstorm"; shortcut: string }

const TOOLS: ToolDef[] = [
  { iconName: "select", label: "Select", tool: "select", shortcut: "1" },
  { iconName: "text", label: "Text", tool: "text", shortcut: "T" },
  { iconName: "drag-area", label: "Drag Area", tool: "drag-area", shortcut: "A" },
  { iconName: "brainstorm", label: "Brainstorm", tool: "brainstorm", shortcut: "B" },
];

export function createToolbar(state: DrawingState): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();

  function makeBtn(def: ToolDef): HTMLButtonElement {
    const btn = h("button", {
      title: `${def.label} (${def.shortcut})`,
      style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", transition: "all 0.15s" },
      children: [icon(def.iconName, 20)],
      onClick: () => {
        if (def.tool === "brainstorm") {
          state.brainstormMode = !state.brainstormMode;
          if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
          state.notify("brainstormMode");
        } else {
          state.tool = def.tool;
          state.brainstormMode = false;
          state.notify("tool");
          state.notify("brainstormMode");
        }
      },
    });
    buttons.set(def.tool, btn);
    return btn;
  }

  const spacer = h("div", { style: { flex: "1" } });

  const undoBtn = h("button", {
    title: "Undo (Cmd+Z)",
    style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", opacity: "0.4" },
    children: [icon("undo", 20)],
    onClick: () => state.undo(),
  });
  const redoBtn = h("button", {
    title: "Redo (Cmd+Shift+Z)",
    style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", opacity: "0.4" },
    children: [icon("redo", 20)],
    onClick: () => state.redo(),
  });

  const resetBtn = h("button", {
    title: "Reset view",
    style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent" },
    children: [icon("reset", 20)],
    onClick: () => { state.camera = { x: 0, y: 0, zoom: 1 }; state.notify("camera"); },
  });

  const bookmarksEl = createBookmarksPanel(state);

  const container = h("div", {
    style: {
      position: "absolute", bottom: "calc(16px + env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "4px", padding: "6px 8px",
      borderRadius: "12px",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)", zIndex: "100", userSelect: "none",
      backdropFilter: "blur(8px)",
    },
    children: [
      ...TOOLS.map(makeBtn),
      spacer,
      bookmarksEl,
      resetBtn,
      undoBtn,
      redoBtn,
    ],
  });

  function update() {
    const theme = state.theme;
    container.style.background = theme.uiBackground;

    const fg = theme.foreground;
    const accent = theme.accent;

    for (const [key, btn] of buttons) {
      const active = key === "brainstorm" ? state.brainstormMode : (state.tool === key && !state.brainstormMode);
      btn.style.color = active ? accent : fg;
      btn.style.opacity = active ? "1" : "0.6";
    }
    undoBtn.style.color = fg;
    redoBtn.style.color = fg;
    resetBtn.style.color = fg;
    undoBtn.style.opacity = state.canUndo ? "0.8" : "0.3";
    redoBtn.style.opacity = state.canRedo ? "0.8" : "0.3";
  }

  state.addEventListener("change", update);
  update();
  return container;
}
