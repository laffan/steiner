import type { DrawingState } from "../state";
import type { Shape } from "../types";
import { getShapeBounds } from "../utils";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";

interface ShelfNode {
  id: string; type: string; label: string; excerpt: string;
  color: string | null; shapeId: string; parentId: string | undefined; depth: number;
  pocketed: boolean;
}

export function createShelfPanel(
  state: DrawingState,
  opts: { shelfItems: string[]; onRemoveShelfItem: (i: number) => void; onRestoreShelfItem: (i: number) => void },
): HTMLElement {
  let isOpen = false;
  let search = "";
  let activeTag: string | null = null;
  const collapsed = new Set<string>();
  const pinned = new Set<string>();

  const panel = h("div", {
    style: { position: "absolute", top: "calc(env(safe-area-inset-top) + 20px)", right: "env(safe-area-inset-right)", bottom: "calc(env(safe-area-inset-bottom) + 20px)", zIndex: "150", display: "flex", flexDirection: "column", transition: "width 0.2s", overflow: "hidden", width: "24px", minWidth: "24px", borderRadius: "12px 0 0 12px" },
  });

  const grip = h("button", {
    text: "\u2039",
    style: { width: "24px", height: "100%", position: "absolute", left: "0", top: "0", border: "none", borderRight: "none", borderRadius: "12px 0 0 12px", cursor: "pointer", fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: "10" },
    onClick: () => { isOpen = !isOpen; rebuild(); },
  });
  panel.appendChild(grip);

  const content = h("div", {
    style: { marginLeft: "24px", flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", padding: "20px 20px 20px 0" },
  });
  panel.appendChild(content);

  function t() { return state.theme; }

  function applyTheme() {
    const theme = t();
    panel.style.background = theme.uiBackground;
    panel.style.border = `1px solid ${theme.gridColor}`;
    panel.style.borderRight = "none";
    grip.style.background = "transparent";
    grip.style.borderColor = "transparent";
    grip.style.color = theme.foreground;
  }

  function buildNodes(shapes: Shape[]): ShelfNode[] {
    const result: ShelfNode[] = [];
    const dragAreas = shapes.filter((s) => s.type === "drag-area");
    const others = shapes.filter((s) => s.type === "text" || s.type === "image");

    for (const da of dragAreas) {
      const children = shapes.filter((s) => s.parentId === da.id);
      const textChildren = children.filter((s) => s.type === "text");
      let name = `(${children.length} items)`;
      if (textChildren.length > 0) {
        const sorted = [...textChildren].sort((a, b) => { const ab = getShapeBounds(a); const bb = getShapeBounds(b); return ab.minY - bb.minY || ab.minX - bb.minX; });
        if (sorted[0].type === "text") { const tx = sorted[0].text.substring(0, 40); name = `${tx}${sorted[0].text.length > 40 ? "..." : ""}`; }
      }
      result.push({ id: da.id, type: "drag-area", label: name, excerpt: "", color: da.type === "drag-area" ? da.strokeColor : null, shapeId: da.id, parentId: undefined, depth: 0, pocketed: !!da.pocketed });
      if (!collapsed.has(da.id)) {
        const sortedChildren = [...children].sort((a, b) => { const ab = getShapeBounds(a); const bb = getShapeBounds(b); return ab.minY - bb.minY || ab.minX - bb.minX; });
        for (const child of sortedChildren) {
          if (child.type === "text") {
            result.push({ id: child.id, type: "text", label: child.text.substring(0, 50) + (child.text.length > 50 ? "..." : ""), excerpt: child.text, color: child.backgroundColor || null, shapeId: child.id, parentId: da.id, depth: 1, pocketed: !!child.pocketed });
          } else if (child.type === "image") {
            result.push({ id: child.id, type: "image", label: child.name || "Image", excerpt: "", color: null, shapeId: child.id, parentId: da.id, depth: 1, pocketed: !!child.pocketed });
          }
        }
      }
    }

    const rootOthers = others.filter((s) => !s.parentId).sort((a, b) => { const ab = getShapeBounds(a); const bb = getShapeBounds(b); return ab.minY - bb.minY || ab.minX - bb.minX; });
    for (const s of rootOthers) {
      if (s.type === "text") {
        if (!s.text.trim()) continue;
        result.push({ id: s.id, type: "text", label: s.text.substring(0, 50) + (s.text.length > 50 ? "..." : ""), excerpt: s.text, color: s.backgroundColor || null, shapeId: s.id, parentId: undefined, depth: 0, pocketed: !!s.pocketed });
      } else if (s.type === "image") {
        result.push({ id: s.id, type: "image", label: s.name || "Image", excerpt: "", color: null, shapeId: s.id, parentId: undefined, depth: 0, pocketed: !!s.pocketed });
      }
    }
    return result;
  }

  function rebuild() {
    applyTheme();
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#888";
    const border = theme.uiBorder;
    const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";
    const inputBg = theme.variant === "dark" ? "rgba(255,255,255,0.06)" : "#fff";
    const inputBorder = theme.variant === "dark" ? "rgba(255,255,255,0.12)" : "#e5e7eb";

    panel.style.width = isOpen ? "280px" : "24px";
    panel.style.minWidth = isOpen ? "280px" : "24px";
    grip.textContent = isOpen ? "\u203a" : "\u2039";
    content.style.display = isOpen ? "flex" : "none";
    if (!isOpen) return;

    clearChildren(content);

    // Search
    const searchContainer = h("div", { style: { position: "relative", marginBottom: "8px" } });
    const searchInput = h("input", { attrs: { type: "text", placeholder: "Search..." }, style: { width: "100%", padding: "6px 28px 6px 8px", border: `1px solid ${inputBorder}`, borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box", background: inputBg, color: fg } });
    (searchInput as HTMLInputElement).value = search;
    searchInput.addEventListener("input", () => { search = (searchInput as HTMLInputElement).value; rebuild(); });
    searchContainer.appendChild(searchInput);
    if (search) {
      searchContainer.appendChild(h("button", { text: "\u00d7", style: { position: "absolute", right: "14px", top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", fontSize: "16px", color: muted }, onClick: () => { search = ""; rebuild(); } }));
    }
    content.appendChild(searchContainer);

    const nodes = buildNodes(state.shapes);

    // Tags
    const tags = new Set<string>();
    const tagRegex = /#([\w-]+)/g;
    for (const n of nodes) { let m; while ((m = tagRegex.exec(n.excerpt)) !== null) tags.add(m[1]); }
    const sortedTags = Array.from(tags).sort();
    if (sortedTags.length > 0) {
      const tagBar = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px", paddingBottom: "8px" } });
      for (const tag of sortedTags) {
        const active = activeTag === tag;
        tagBar.appendChild(h("button", { text: `#${tag}`, style: { padding: "2px 8px", border: "none", borderRadius: "10px", fontSize: "11px", cursor: "pointer", background: active ? theme.accent : (theme.variant === "dark" ? "rgba(255,255,255,0.08)" : "#f1f3f5"), color: active ? "#fff" : muted }, onClick: () => { activeTag = activeTag === tag ? null : tag; rebuild(); } }));
      }
      content.appendChild(tagBar);
    }

    // Filter
    let filtered = nodes;
    if (search.trim()) { const q = search.toLowerCase(); filtered = filtered.filter((n) => n.label.toLowerCase().includes(q) || n.excerpt.toLowerCase().includes(q)); }
    if (activeTag) filtered = filtered.filter((n) => n.excerpt.includes(`#${activeTag}`));

    const pinnedItems = filtered.filter((n) => pinned.has(n.id));
    const unpinnedItems = filtered.filter((n) => !pinned.has(n.id));

    // Shelf items
    if (opts.shelfItems.length > 0) {
      const section = h("div", { style: { padding: "4px 0", borderBottom: `1px solid ${border}` } });
      section.appendChild(h("div", { text: "Shelved", style: { fontSize: "11px", fontWeight: "600", color: muted, textTransform: "uppercase", letterSpacing: "0.5px", padding: "4px 0" } }));
      opts.shelfItems.forEach((text, i) => {
        const row = h("div", {
          style: { display: "flex", alignItems: "center", gap: "4px", padding: "4px 0", fontSize: "13px", borderBottom: `1px solid ${subtleBorder}`, cursor: "grab", color: fg },
          attrs: { draggable: "true" },
        });
        row.addEventListener("dragstart", (e) => {
          if (e.dataTransfer) {
            e.dataTransfer.setData("application/x-shelf-index", String(i));
            e.dataTransfer.effectAllowed = "copyMove";
            const ghost = document.createElement("div");
            Object.assign(ghost.style, { padding: "6px 12px", background: theme.accent, color: "#fff", borderRadius: "6px", fontSize: "13px", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", position: "absolute", top: "-1000px" });
            ghost.textContent = text.substring(0, 50);
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, 10, 10);
            setTimeout(() => ghost.remove(), 0);
          }
        });
        row.appendChild(h("span", { text, style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }));
        row.appendChild(h("button", { text: "\u00d7", style: { border: "none", background: "none", cursor: "pointer", fontSize: "10px", padding: "0", opacity: "0.5", color: muted }, onClick: () => opts.onRemoveShelfItem(i) }));
        section.appendChild(row);
      });
      content.appendChild(section);
    }

    // Pinned
    if (pinnedItems.length > 0) {
      const section = h("div", { style: { padding: "4px 0", borderBottom: `1px solid ${border}` } });
      const pinnedHeader = h("div", { style: { fontSize: "11px", fontWeight: "600", color: muted, textTransform: "uppercase", letterSpacing: "0.5px", padding: "4px 0", display: "flex", alignItems: "center", gap: "4px" } });
      const pinnedIcon = icon("pin", 11);
      pinnedIcon.style.color = muted;
      pinnedHeader.appendChild(pinnedIcon);
      pinnedHeader.appendChild(document.createTextNode("Pinned"));
      section.appendChild(pinnedHeader);
      pinnedItems.forEach((n) => section.appendChild(makeNodeRow(n, true)));
      content.appendChild(section);
    }

    // All items
    const scrollArea = h("div", { style: { flex: "1", overflowY: "auto", padding: "4px 0" } });
    if (unpinnedItems.length === 0 && opts.shelfItems.length === 0) {
      scrollArea.appendChild(h("div", { text: "No items. Add shapes to the canvas.", style: { padding: "16px", textAlign: "center", fontSize: "12px", color: muted } }));
    }
    unpinnedItems.forEach((n) => scrollArea.appendChild(makeNodeRow(n, false)));
    content.appendChild(scrollArea);
  }

  function makeNodeRow(node: ShelfNode, isPinned: boolean): HTMLElement {
    const theme = t();
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#999";
    const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";
    const row = h("div", { style: { display: "flex", alignItems: "center", gap: "4px", padding: "4px 0", cursor: "pointer", fontSize: "13px", borderBottom: `1px solid ${subtleBorder}`, paddingLeft: (node.depth * 16) + "px", borderLeft: node.color ? `3px solid ${node.color}` : "3px solid transparent", color: fg } });
    if (node.type === "drag-area") {
      row.appendChild(h("button", { text: collapsed.has(node.id) ? "\u25b8" : "\u25be", style: { border: "none", background: "none", cursor: "pointer", fontSize: "10px", color: muted, padding: "0", width: "16px" }, onClick: () => { if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id); rebuild(); } }));
    }
    if (node.type === "drag-area") {
      const daIcon = icon("drag-area", 12);
      daIcon.style.flexShrink = "0";
      daIcon.style.color = muted;
      daIcon.style.marginRight = "2px";
      row.appendChild(daIcon);
    }
    if (node.pocketed) {
      const pocketIcon = icon("pocket", 12);
      pocketIcon.style.flexShrink = "0";
      pocketIcon.style.color = muted;
      pocketIcon.style.marginRight = "2px";
      row.appendChild(pocketIcon);
    }
    row.appendChild(h("span", { text: node.label, style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }, onClick: () => state.focusShape(node.shapeId) }));
    const pinBtn = h("button", { title: isPinned ? "Unpin" : "Pin", style: { border: "none", background: "none", cursor: "pointer", padding: "0", opacity: isPinned ? "0.8" : "0.4", color: isPinned ? theme.accent : muted, display: "flex", alignItems: "center", width: "16px", height: "16px" }, onClick: () => { if (isPinned) pinned.delete(node.id); else pinned.add(node.id); rebuild(); } });
    pinBtn.appendChild(icon("pin", 12));
    row.appendChild(pinBtn);
    return row;
  }

  state.addEventListener("change", rebuild);
  rebuild();
  return panel;
}
