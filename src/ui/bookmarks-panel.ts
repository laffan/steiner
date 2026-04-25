import type { DrawingState } from "../state";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";

export function createBookmarksPanel(state: DrawingState): HTMLElement {
  let isOpen = false;
  let adding = false;
  let animatingUpdateId: string | null = null;

  const container = h("div", { style: { position: "relative" } });
  const toggleBtn = h("button", {
    style: { width: "36px", height: "36px", border: "none", borderRadius: "8px", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" },
    title: "Canvas bookmarks",
    onClick: () => { isOpen = !isOpen; rebuild(); },
  });
  container.appendChild(toggleBtn);

  const dropdown = h("div", {
    style: { position: "absolute", bottom: "100%", left: "0", marginBottom: "4px", borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.12)", width: "220px", overflow: "hidden", display: "none", zIndex: "300" },
  });
  container.appendChild(dropdown);

  // Close on click outside
  document.addEventListener("pointerdown", (e) => {
    if (!isOpen) return;
    const target = e.target as HTMLElement;
    if (container.contains(target)) return;
    isOpen = false;
    adding = false;
    rebuild();
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (!isOpen) return;
    if (e.key === "Escape") { isOpen = false; adding = false; rebuild(); }
  });

  function rebuild() {
    const theme = state.theme;
    const fg = theme.foreground;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#999";

    // Toggle button
    clearChildren(toggleBtn);
    toggleBtn.style.color = fg;
    toggleBtn.appendChild(icon("canvas-bookmarks", 20));
    if (state.bookmarks.length > 0) {
      const badge = h("span", { text: String(state.bookmarks.length), style: { position: "absolute", top: "2px", right: "2px", fontSize: "9px", background: theme.accent, color: "#fff", borderRadius: "8px", padding: "0px 4px", fontWeight: "600", lineHeight: "14px" } });
      toggleBtn.appendChild(badge);
    }

    dropdown.style.display = isOpen ? "block" : "none";
    dropdown.style.background = theme.uiBackground;
    dropdown.style.border = `1px solid ${theme.uiBorder}`;
    if (!isOpen) return;

    clearChildren(dropdown);
    dropdown.appendChild(h("div", { text: "Bookmarks", style: { padding: "8px 12px", fontWeight: "600", fontSize: "13px", borderBottom: `1px solid ${theme.uiBorder}`, color: fg } }));

    for (const bm of state.bookmarks) {
      const row = h("div", { style: { display: "flex", alignItems: "center", padding: "6px 12px", borderBottom: `1px solid ${theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa"}`, fontSize: "13px", gap: "2px" } });
      row.appendChild(h("span", { text: bm.name, style: { flex: "1", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: fg }, onClick: () => { state.goToBookmark(bm); isOpen = false; rebuild(); } }));
      const updateIcon = icon("update", 14);
      const updateBtn = h("button", { title: "Update to current view", style: { border: "none", background: "none", cursor: "pointer", color: muted, display: "flex", alignItems: "center", padding: "2px" }, onClick: () => { animatingUpdateId = bm.id; state.updateBookmark(bm.id); } });
      updateBtn.appendChild(updateIcon);
      row.appendChild(updateBtn);
      // Trigger spin animation after rebuild recreates this icon
      if (animatingUpdateId === bm.id) {
        animatingUpdateId = null;
        requestAnimationFrame(() => {
          updateIcon.style.transition = "transform 0.4s ease";
          updateIcon.style.transform = "rotate(360deg)";
        });
      }
      const deleteBtn = h("button", { title: "Delete bookmark", style: { border: "none", background: "none", cursor: "pointer", color: muted, display: "flex", alignItems: "center", padding: "2px" }, onClick: () => { state.deleteBookmark(bm.id); rebuild(); } });
      deleteBtn.appendChild(icon("trash", 14));
      row.appendChild(deleteBtn);
      dropdown.appendChild(row);
    }

    if (state.bookmarks.length === 0) {
      dropdown.appendChild(h("div", { text: "No bookmarks yet", style: { padding: "12px", textAlign: "center", fontSize: "12px", color: muted } }));
    }

    if (adding) {
      const inputBg = theme.variant === "dark" ? "rgba(255,255,255,0.06)" : "#fff";
      const form = h("div", { style: { display: "flex", padding: "6px", gap: "4px" } });
      const input = h("input", { style: { flex: "1", padding: "4px 8px", border: `1px solid ${theme.uiBorder}`, borderRadius: "4px", fontSize: "12px", outline: "none", background: inputBg, color: fg }, attrs: { type: "text", placeholder: "Bookmark name" } });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doAdd();
        if (e.key === "Escape") { adding = false; rebuild(); }
      });
      const addBtn = h("button", { text: "\u2713", style: { border: "none", background: theme.accent, color: "#fff", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", fontSize: "12px" }, onClick: doAdd });
      form.appendChild(input);
      form.appendChild(addBtn);
      dropdown.appendChild(form);
      setTimeout(() => input.focus(), 10);

      function doAdd() {
        const name = input.value.trim();
        if (name) { state.addBookmark(name); adding = false; rebuild(); }
      }
    } else {
      dropdown.appendChild(h("button", { text: "+ Save current view", style: { width: "100%", padding: "8px 12px", border: "none", background: theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa", cursor: "pointer", fontSize: "12px", color: theme.accent, textAlign: "left" }, onClick: () => { adding = true; rebuild(); } }));
    }
  }

  state.addEventListener("change", rebuild);
  rebuild();
  return container;
}
