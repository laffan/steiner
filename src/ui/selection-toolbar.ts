import type { DrawingState } from "../state";
import { COLOR_PALETTE, BACKGROUND_COLORS, TEXT_COLORS } from "../types";
import { canvasToScreen, computePocketLayout, getShapeBounds } from "../utils";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";
import { HIGHLIGHT_STYLE } from "./chat-bubble";

type PopupType = "color" | "bg" | "size" | "align" | "termStyle";

// The four chat-segment "kinds" mapped onto canvas-friendly text styles.
// Order is the visual order in the popup row.
const TERM_STYLE_PRESETS: { kind: "concept" | "name" | "book" | "definition"; label: string }[] = [
  { kind: "name", label: "Name" },
  { kind: "definition", label: "Definition" },
  { kind: "book", label: "Book" },
  { kind: "concept", label: "Concept" },
];

export function createSelectionToolbar(state: DrawingState, onMoveToShelf: () => void): HTMLElement {
  const container = h("div", {
    style: { position: "absolute", display: "none", gap: "2px", zIndex: "200", pointerEvents: "auto" },
  });

  let activePopup: PopupType | null = null;
  let popupEl: HTMLElement | null = null;
  let popupWrapper: HTMLElement | null = null;
  let isRenamingImage = false;

  function closePopup() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
    activePopup = null;
    popupWrapper = null;
  }

  function makeIconBtn(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
    const theme = state.theme;
    return h("button", {
      title,
      style: { width: "28px", height: "28px", border: "none", borderRadius: "6px", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: theme.foreground },
      children: [icon(iconName, 18)],
      onClick,
    });
  }

  function makePalette(colors: readonly string[], onSelect: (c: string) => void): HTMLElement {
    const theme = state.theme;
    return h("div", {
      style: { position: "absolute", top: "-36px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "4px", padding: "6px 8px", background: theme.uiBackground, borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`, zIndex: "300" },
      children: colors.map((c) => {
        if (c === "reset") {
          const btn = h("button", {
            title: "Reset",
            style: { width: "14px", height: "14px", borderRadius: "50%", border: "1px solid #ccc", background: "#fff", cursor: "pointer", padding: "0", position: "relative" },
            onClick: () => onSelect(c),
          });
          const slash = h("span", { style: { position: "absolute", top: "50%", left: "-1px", width: "14px", height: "1px", background: "red", transform: "rotate(45deg)", transformOrigin: "center" } });
          btn.appendChild(slash);
          return btn;
        }
        return h("button", {
          title: c,
          style: { width: "14px", height: "14px", borderRadius: "50%", border: "none", background: COLOR_PALETTE[c] || "#ccc", cursor: "pointer", padding: "0" },
          onClick: () => onSelect(c),
        });
      }),
    });
  }

  function makeSizeSlider(currentSize: number, onChange: (size: number) => void): HTMLElement {
    const theme = state.theme;
    const panel = h("div", {
      style: { position: "absolute", top: "-44px", left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: "6px", padding: "6px 10px", background: theme.uiBackground, borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`, zIndex: "300", whiteSpace: "nowrap" },
    });
    const slider = h("input", {
      attrs: { type: "range", min: "6", max: "30", step: "1" },
      style: { width: "100px" },
    }) as HTMLInputElement;
    slider.value = String(currentSize);
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.5)" : "#666";
    const label = h("span", { text: `${currentSize}px`, style: { fontSize: "11px", color: muted, minWidth: "32px" } });
    slider.addEventListener("input", () => {
      const v = parseInt(slider.value, 10);
      label.textContent = `${v}px`;
      onChange(v);
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.appendChild(h("span", { text: "A", style: { fontSize: "10px", color: muted } }));
    panel.appendChild(slider);
    panel.appendChild(h("span", { text: "A", style: { fontSize: "16px", fontWeight: "600", color: theme.foreground } }));
    panel.appendChild(label);
    return panel;
  }

  // Close popup on click outside
  document.addEventListener("pointerdown", (e) => {
    if (!popupEl || !activePopup) return;
    const target = e.target as HTMLElement;
    if (popupEl.contains(target)) return;
    if (popupWrapper?.contains(target)) return;
    closePopup();
  });

  function makeTermStyleMenu(state: DrawingState): HTMLElement {
    const theme = state.theme;
    const panel = h("div", {
      style: {
        position: "absolute",
        top: "-40px",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: "4px",
        padding: "5px 6px",
        background: theme.uiBackground,
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        border: `1px solid ${theme.uiBorder}`,
        zIndex: "300",
        whiteSpace: "nowrap",
      },
    });
    for (const { kind, label } of TERM_STYLE_PRESETS) {
      const styleSpec = HIGHLIGHT_STYLE[kind];
      const bg = (styleSpec.background as string) || "#eee";
      const fg = (styleSpec.color as string) || "#111";
      const chip = h("button", {
        title: `Apply ${label} style`,
        style: {
          padding: "3px 10px",
          border: "1px solid rgba(0,0,0,0.06)",
          borderRadius: "10px",
          background: bg,
          color: fg,
          fontSize: "11px",
          fontWeight: "500",
          cursor: "pointer",
          fontFamily: "inherit",
          fontStyle: (styleSpec.fontStyle as string) || "normal",
        },
        children: [label],
        onClick: () => {
          state.applyTextStyle(fg, bg);
          closePopup();
        },
      });
      panel.appendChild(chip);
    }
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    return panel;
  }

  function makeAlignMenu(state: DrawingState): HTMLElement {
    const theme = state.theme;
    const btnStyle: Partial<CSSStyleDeclaration> = {
      width: "26px", height: "26px", border: "none", borderRadius: "4px",
      background: "transparent", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0", color: theme.foreground,
    };
    const items: { iconName: string; title: string; action: () => void }[] = [
      { iconName: "align-top", title: "Align top", action: () => state.alignSelected("top") },
      { iconName: "align-bottom", title: "Align bottom", action: () => state.alignSelected("bottom") },
      { iconName: "align-left", title: "Align left", action: () => state.alignSelected("left") },
      { iconName: "align-right", title: "Align right", action: () => state.alignSelected("right") },
      { iconName: "align-vertical-spacing", title: "Distribute vertically", action: () => state.distributeSelected("vertical") },
      { iconName: "align-horizontal-spacing", title: "Distribute horizontally", action: () => state.distributeSelected("horizontal") },
    ];
    const panel = h("div", {
      style: { position: "absolute", top: "-40px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "2px", padding: "4px 6px", background: theme.uiBackground, borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`, zIndex: "300" },
      children: items.map((it) => {
        const btn = h("button", { title: it.title, style: { ...btnStyle }, onClick: it.action });
        btn.appendChild(icon(it.iconName, 18));
        return btn;
      }),
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    return panel;
  }

  function togglePopup(type: PopupType, wrapper: HTMLElement, create: () => HTMLElement) {
    if (activePopup === type) { closePopup(); return; }
    closePopup();
    popupEl = create();
    popupWrapper = wrapper;
    activePopup = type;
    wrapper.appendChild(popupEl);
  }

  function update() {
    if (isRenamingImage) return;
    const savedPopup = activePopup;
    clearChildren(container);
    popupEl = null;
    popupWrapper = null;
    activePopup = null;

    if (state.selectedIds.size === 0) {
      container.style.display = "none";
      return;
    }

    const selected = state.shapes.filter((s) => state.selectedIds.has(s.id));
    if (selected.length === 0) { container.style.display = "none"; return; }

    const allPocketed = selected.every((s) => s.pocketed);
    if (allPocketed) { container.style.display = "none"; return; }

    const pocketLayout = computePocketLayout(state.shapes, state.canvasWidth, state.fontFamily);
    const pocketScreenMap = new Map<string, { minX: number; minY: number }>();
    for (const entry of pocketLayout.entries) {
      for (const s of entry.shapes) {
        pocketScreenMap.set(s.id, { minX: entry.screenBounds.minX, minY: entry.screenBounds.minY });
      }
    }
    const allSelectedPocketed = selected.every((s) => pocketLayout.pocketedIds.has(s.id));

    let screenMinX: number, screenMinY: number;
    if (allSelectedPocketed) {
      screenMinX = Infinity; screenMinY = Infinity;
      for (const s of selected) {
        const sb = pocketScreenMap.get(s.id);
        if (sb) { screenMinX = Math.min(screenMinX, sb.minX); screenMinY = Math.min(screenMinY, sb.minY); }
      }
    } else {
      let minX = Infinity, minY = Infinity;
      for (const s of selected) {
        if (pocketLayout.pocketedIds.has(s.id)) continue;
        const b = getShapeBounds(s);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
      }
      const topLeft = canvasToScreen({ x: minX, y: minY }, state.camera);
      // Offset by selection highlight padding (6 canvas units) to align with the
      // dashed selection box drawn in the renderer
      const selPad = 6 * state.camera.zoom;
      screenMinX = topLeft.x - selPad;
      screenMinY = topLeft.y - selPad;
    }

    container.style.display = "flex";
    container.style.left = (screenMinX - 7) + "px";
    container.style.top = (screenMinY - 34) + "px";

    const hasText = selected.some((s) => s.type === "text");
    const hasImage = selected.some((s) => s.type === "image");
    const hasColorable = selected.some((s) => s.type === "text");
    const hasBgable = selected.some((s) => s.type === "text" || s.type === "drag-area");
    const multiSelect = selected.length > 1;

    if (multiSelect) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("align", "Align / Distribute", () => {
        togglePopup("align", wrapper, () => makeAlignMenu(state));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "align") togglePopup("align", wrapper, () => makeAlignMenu(state));
    }
    if (hasText) container.appendChild(makeIconBtn("move-to-shelf", "Move to shelf", onMoveToShelf));

    if (hasText) {
      // Capture any active text-editor selection BEFORE the click (mousedown
      // on a button steals focus from the textarea and clears its selection
      // on some platforms). preventDefault on mousedown keeps focus, but we
      // also snapshot the selection eagerly to be safe.
      let capturedSelection = "";
      const captureSelection = () => {
        // Only the inline text-shape editor counts. We deliberately don't fall
        // back to window.getSelection() here — it leaks selections from
        // unrelated DOM (e.g. a chip the user just clicked in the sidebar),
        // which used to make Ask Claude reuse the previous query.
        capturedSelection = "";
        const ta = document.querySelector<HTMLTextAreaElement>("textarea.inline-text-editor");
        if (ta && typeof ta.selectionStart === "number" && typeof ta.selectionEnd === "number"
          && ta.selectionStart !== ta.selectionEnd) {
          capturedSelection = ta.value.substring(ta.selectionStart, ta.selectionEnd).trim();
        }
      };

      const askBtn = makeIconBtn("send-to-claude", "Ask Claude", () => {
        const textShapes = selected.filter((s) => s.type === "text") as { id: string; text: string }[];
        if (textShapes.length === 0) return;
        let seed = capturedSelection;
        if (!seed) {
          seed = textShapes.map((s) => s.text.trim()).filter(Boolean).join("\n\n");
        }
        if (!seed) return;
        const hook = (window as unknown as {
          steinerAskClaude?: (ids: string[], text: string) => void;
        }).steinerAskClaude;
        if (hook) hook(textShapes.map((s) => s.id), seed);
      });
      askBtn.addEventListener("pointerdown", (e) => {
        // Snapshot before focus shifts; preventDefault keeps the textarea
        // focused so its visible selection (and any subsequent paste) is
        // preserved if the user re-engages with it.
        captureSelection();
        e.preventDefault();
      });
      container.appendChild(askBtn);

    }

    if (hasImage && selected.length === 1) {
      const isCropping = state.croppingImageId === selected[0].id;
      container.appendChild(makeIconBtn("crop", isCropping ? "Finish crop" : "Crop image", () => {
        if (isCropping) state.stopCropping();
        else state.startCropping(selected[0].id);
      }));
    }

    if (hasColorable) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("text-color", "Text color", () => {
        togglePopup("color", wrapper, () => makePalette(TEXT_COLORS, (c) => {
          state.changeSelectedColor(c === "reset" ? "black" : c);
          closePopup();
        }));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "color") togglePopup("color", wrapper, () => makePalette(TEXT_COLORS, (c) => {
        state.changeSelectedColor(c === "reset" ? "black" : c);
        closePopup();
      }));
    }

    if (hasBgable) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("background-color", "Background", () => {
        togglePopup("bg", wrapper, () => makePalette(BACKGROUND_COLORS, (c) => {
          state.changeSelectedBackground(c);
          closePopup();
        }));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "bg") togglePopup("bg", wrapper, () => makePalette(BACKGROUND_COLORS, (c) => {
        state.changeSelectedBackground(c);
        closePopup();
      }));
    }

    if (hasText) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("term-style", "Term style", () => {
        togglePopup("termStyle", wrapper, () => makeTermStyleMenu(state));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "termStyle") {
        togglePopup("termStyle", wrapper, () => makeTermStyleMenu(state));
      }
    }

    if (hasText) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("text-size", "Text size", () => {
        const textShape = selected.find((s) => s.type === "text");
        const currentSize = textShape && textShape.type === "text" ? textShape.fontSize : 18;
        togglePopup("size", wrapper, () => makeSizeSlider(currentSize, (size) => {
          state.changeSelectedFontSize(size);
        }));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "size") {
        const textShape = selected.find((s) => s.type === "text");
        const currentSize = textShape && textShape.type === "text" ? textShape.fontSize : 18;
        togglePopup("size", wrapper, () => makeSizeSlider(currentSize, (size) => {
          state.changeSelectedFontSize(size);
        }));
      }
    }

    container.appendChild(makeIconBtn("trash", "Delete", () => state.deleteSelected()));

    // Inline image rename
    if (hasImage && selected.length === 1 && selected[0].type === "image") {
      const imgShape = selected[0];
      const fullName = imgShape.name || "";
      const dotIdx = fullName.lastIndexOf(".");
      const baseName = dotIdx > 0 ? fullName.substring(0, dotIdx) : fullName;
      const ext = dotIdx > 0 ? fullName.substring(dotIdx) : "";

      const theme = state.theme;
      const nameEl = h("span", {
        text: baseName,
        style: { fontSize: "14px", color: theme.foreground, cursor: "pointer", whiteSpace: "nowrap", marginLeft: "4px", lineHeight: "28px" },
      });

      let committed = false;
      function commitRename() {
        if (committed) return;
        committed = true;
        isRenamingImage = false;
        nameEl.removeAttribute("contenteditable");
        nameEl.style.color = theme.foreground;
        nameEl.style.outline = "none";
        nameEl.style.minWidth = "";
        nameEl.removeEventListener("blur", commitRename);
        const newBase = (nameEl.textContent || "").trim();
        if (newBase && newBase !== baseName) {
          state.renameImage(imgShape.id, newBase + ext);
        }
      }

      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (nameEl.getAttribute("contenteditable") === "true") return;
        committed = false;
        isRenamingImage = true;
        nameEl.setAttribute("contenteditable", "true");
        nameEl.style.color = theme.accent;
        nameEl.style.outline = "none";
        nameEl.style.minWidth = "40px";
        nameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
      nameEl.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); commitRename(); }
      });
      nameEl.addEventListener("blur", commitRename);
      nameEl.addEventListener("pointerdown", (e) => e.stopPropagation());

      container.appendChild(nameEl);
    }
  }

  state.addEventListener("change", update);
  update();
  return container;
}
