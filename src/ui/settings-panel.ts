import type { DrawingState } from "../state";
import type { AppearanceMode } from "../themes";
import { THEMES, THEME_IDS } from "../themes";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";

export function createSettingsPanel(state: DrawingState, mountOverlayOn?: HTMLElement): HTMLElement {
  let isOpen = false;

  const toggleBtn = h("button", {
    title: "Settings",
    style: {
      width: "36px", height: "36px", border: "none", borderRadius: "8px",
      background: "rgba(255,255,255,0.9)", boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
      cursor: "pointer", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#333",
    },
    children: [icon("settings", 20)],
    onClick: () => { isOpen = !isOpen; rebuild(); },
  });

  // Modal overlay — mounted at root level to avoid iOS transform clipping
  const overlay = h("div", {
    style: {
      display: "none", position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
      background: "rgba(0,0,0,0.3)", zIndex: "500", alignItems: "center", justifyContent: "center",
    },
  });
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { isOpen = false; rebuild(); }
  });
  if (mountOverlayOn) mountOverlayOn.appendChild(overlay);
  else toggleBtn.appendChild(overlay);

  const modal = h("div", {
    style: {
      background: "#fff", borderRadius: "12px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      width: "min(440px, 90vw)", maxHeight: "80vh", overflow: "auto", padding: "0",
    },
  });
  overlay.appendChild(modal);

  function rebuild() {
    overlay.style.display = isOpen ? "flex" : "none";
    if (!isOpen) return;

    clearChildren(modal);

    // Header
    const header = h("div", {
      style: { display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" },
    });
    header.appendChild(h("span", { text: "Settings", style: { flex: "1", fontSize: "16px", fontWeight: "600", color: "#333" } }));
    header.appendChild(h("button", {
      text: "\u00d7",
      style: { border: "none", background: "none", cursor: "pointer", fontSize: "20px", color: "#999", padding: "0", lineHeight: "1" },
      onClick: () => { isOpen = false; rebuild(); },
    }));
    modal.appendChild(header);

    // Appearance mode
    const appearSection = h("div", { style: { padding: "16px 20px", borderBottom: "1px solid #f1f3f5" } });
    appearSection.appendChild(h("div", { text: "Appearance", style: { fontSize: "13px", fontWeight: "600", color: "#555", marginBottom: "8px" } }));
    const modeRow = h("div", { style: { display: "flex", gap: "6px" } });
    const modes: { label: string; value: AppearanceMode }[] = [
      { label: "Light", value: "light" },
      { label: "Dark", value: "dark" },
      { label: "Auto", value: "auto" },
    ];
    for (const mode of modes) {
      const active = state.appearanceMode === mode.value;
      modeRow.appendChild(h("button", {
        text: mode.label,
        style: {
          padding: "5px 14px", border: "1px solid " + (active ? "#4285f4" : "#ddd"), borderRadius: "6px",
          background: active ? "#4285f4" : "#fff", color: active ? "#fff" : "#555",
          cursor: "pointer", fontSize: "12px", fontWeight: active ? "600" : "400",
        },
        onClick: () => { state.setAppearance(mode.value); rebuild(); },
      }));
    }
    appearSection.appendChild(modeRow);
    modal.appendChild(appearSection);

    // Theme
    const themeSection = h("div", { style: { padding: "16px 20px", borderBottom: "1px solid #f1f3f5" } });
    themeSection.appendChild(h("div", { text: "Theme", style: { fontSize: "13px", fontWeight: "600", color: "#555", marginBottom: "8px" } }));
    const grid = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "6px" } });
    for (const id of THEME_IDS) {
      const t = THEMES[id];
      const active = state.themeId === id;
      const swatch = h("button", {
        style: {
          padding: "6px 4px", border: active ? "2px solid " + t.accent : "1px solid #ddd",
          borderRadius: "6px", background: t.canvasBackground, cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
        },
        onClick: () => { state.setTheme(id); rebuild(); },
      });
      swatch.appendChild(h("div", { style: { display: "flex", gap: "2px" } , children: [
        h("div", { style: { width: "8px", height: "8px", borderRadius: "50%", background: t.foreground } }),
        h("div", { style: { width: "8px", height: "8px", borderRadius: "50%", background: t.accent } }),
      ]}));
      swatch.appendChild(h("span", { text: t.name, style: { fontSize: "9px", color: t.foreground, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "80px" } }));
      grid.appendChild(swatch);
    }
    themeSection.appendChild(grid);
    modal.appendChild(themeSection);

    // Background pattern
    const bgSection = h("div", { style: { padding: "16px 20px", borderBottom: "1px solid #f1f3f5" } });
    bgSection.appendChild(h("div", { text: "Background Pattern", style: { fontSize: "13px", fontWeight: "600", color: "#555", marginBottom: "8px" } }));
    const patternRow = h("div", { style: { display: "flex", gap: "6px", marginBottom: "10px" } });
    const patterns: { label: string; value: "grid" | "dot-grid" | "blank" }[] = [
      { label: "Grid", value: "grid" },
      { label: "Dots", value: "dot-grid" },
      { label: "Blank", value: "blank" },
    ];
    for (const pat of patterns) {
      const active = state.backgroundPattern === pat.value;
      patternRow.appendChild(h("button", {
        text: pat.label,
        style: {
          padding: "5px 14px", border: "1px solid " + (active ? "#4285f4" : "#ddd"), borderRadius: "6px",
          background: active ? "#4285f4" : "#fff", color: active ? "#fff" : "#555",
          cursor: "pointer", fontSize: "12px", fontWeight: active ? "600" : "400",
        },
        onClick: () => { state.backgroundPattern = pat.value; state.notify("theme"); rebuild(); },
      }));
    }
    bgSection.appendChild(patternRow);
    if (state.backgroundPattern !== "blank") {
      bgSection.appendChild(h("div", { text: "Spacing", style: { fontSize: "12px", color: "#666", marginBottom: "4px" } }));
      const spacingRow = h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } });
      const spacingInput = h("input", {
        attrs: { type: "range", min: "10", max: "60", step: "5" },
        style: { flex: "1" },
      }) as HTMLInputElement;
      spacingInput.value = String(state.gridSpacing);
      const spacingLabel = h("span", { text: `${state.gridSpacing}px`, style: { fontSize: "12px", color: "#666", minWidth: "36px" } });
      spacingInput.addEventListener("input", () => {
        state.gridSpacing = parseInt(spacingInput.value, 10);
        spacingLabel.textContent = `${state.gridSpacing}px`;
        state.notify("theme");
      });
      spacingRow.appendChild(spacingInput);
      spacingRow.appendChild(spacingLabel);
      bgSection.appendChild(spacingRow);

      // Opacity
      bgSection.appendChild(h("div", { text: "Opacity", style: { fontSize: "12px", color: "#666", marginBottom: "4px", marginTop: "8px" } }));
      const opacityRow = h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } });
      const opacityInput = h("input", {
        attrs: { type: "range", min: "0", max: "100", step: "5" },
        style: { flex: "1" },
      }) as HTMLInputElement;
      opacityInput.value = String(Math.round(state.gridOpacity * 100));
      const opacityLabel = h("span", { text: `${Math.round(state.gridOpacity * 100)}%`, style: { fontSize: "12px", color: "#666", minWidth: "36px" } });
      opacityInput.addEventListener("input", () => {
        state.gridOpacity = parseInt(opacityInput.value, 10) / 100;
        opacityLabel.textContent = `${opacityInput.value}%`;
        state.notify("theme");
      });
      opacityRow.appendChild(opacityInput);
      opacityRow.appendChild(opacityLabel);
      bgSection.appendChild(opacityRow);
    }
    modal.appendChild(bgSection);

    // Font family
    const ffSection = h("div", { style: { padding: "16px 20px", borderBottom: "1px solid #f1f3f5" } });
    ffSection.appendChild(h("div", { text: "Text Font", style: { fontSize: "13px", fontWeight: "600", color: "#555", marginBottom: "8px" } }));
    const fontFamilies = [
      "Inter", "Source Sans Pro", "Source Serif Pro", "Libre Franklin",
      "Libre Baskerville", "Karla", "Lora", "Helvetica", "EB Garamond", "Fira Code",
    ];
    const ffSelect = document.createElement("select");
    Object.assign(ffSelect.style, { width: "100%", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#fff" });
    for (const ff of fontFamilies) {
      const opt = document.createElement("option");
      opt.value = ff; opt.textContent = ff;
      opt.style.fontFamily = ff;
      if (state.fontFamily === ff) opt.selected = true;
      ffSelect.appendChild(opt);
    }
    ffSelect.addEventListener("change", () => { state.fontFamily = ffSelect.value; state.notify("theme"); rebuild(); });
    ffSection.appendChild(ffSelect);
    // Preview
    ffSection.appendChild(h("div", { text: "The quick brown fox jumps over the lazy dog.", style: { fontFamily: state.fontFamily, fontSize: "14px", color: "#666", marginTop: "8px", lineHeight: "1.4" } }));
    modal.appendChild(ffSection);

    // Font size setting
    const fontSection = h("div", { style: { padding: "16px 20px", borderBottom: "1px solid #f1f3f5" } });
    fontSection.appendChild(h("div", { text: "Default Font Size", style: { fontSize: "13px", fontWeight: "600", color: "#555", marginBottom: "8px" } }));
    const fontRow = h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } });
    const fontInput = h("input", {
      attrs: { type: "range", min: "12", max: "36", step: "1" },
      style: { flex: "1" },
    }) as HTMLInputElement;
    fontInput.value = String(state.fontSize);
    const fontLabel = h("span", { text: `${state.fontSize}px`, style: { fontSize: "13px", color: "#666", minWidth: "40px" } });
    fontInput.addEventListener("input", () => {
      state.fontSize = parseInt(fontInput.value, 10);
      fontLabel.textContent = `${state.fontSize}px`;
      state.notify("fontSize");
    });
    fontRow.appendChild(fontInput);
    fontRow.appendChild(fontLabel);
    fontSection.appendChild(fontRow);
    modal.appendChild(fontSection);

    // Keyboard shortcuts reference
    const shortcutsSection = h("div", { style: { padding: "16px 20px" } });
    shortcutsSection.appendChild(h("div", { text: "Keyboard Shortcuts", style: { fontSize: "13px", fontWeight: "600", color: "#555", marginBottom: "8px" } }));
    const shortcuts: [string, string][] = [
      ["1", "Select tool"],
      ["T", "Text tool"],
      ["A", "Drag Area tool"],
      ["B", "Brainstorm mode"],
      ["Space (hold)", "Pan canvas"],
      ["Delete", "Delete selected"],
      ["Ctrl+Z", "Undo"],
      ["Ctrl+Shift+Z", "Redo"],
      ["Ctrl+G", "Group"],
      ["Ctrl+Shift+G", "Ungroup"],
      ["Alt+drag", "Duplicate"],
      ["Double-click", "New text"],
    ];
    for (const [key, desc] of shortcuts) {
      const row = h("div", { style: { display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: "12px" } });
      row.appendChild(h("span", { text: key, style: { fontFamily: "monospace", background: "#f1f3f5", padding: "1px 6px", borderRadius: "3px", color: "#333" } }));
      row.appendChild(h("span", { text: desc, style: { color: "#666" } }));
      shortcutsSection.appendChild(row);
    }
    modal.appendChild(shortcutsSection);
  }

  return toggleBtn;
}
