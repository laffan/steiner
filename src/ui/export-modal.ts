/**
 * Canvas export modal. Collects scope/format/scale/margin/background
 * options, hands them to `exportCanvas()`, and writes the result to
 * disk (Tauri) or triggers a browser download. iOS falls back to the
 * Web Share API since the document picker can't write 0-byte files.
 */

import type { NotesCanvas } from "../notes-canvas";
import { exportCanvas, extensionForFormat, mimeForFormat, type ExportFormat, type ExportOptions, type ExportScale, type ExportScope } from "../notebook-export";
import { IS_TAURI } from "../runtime";
import { h } from "./dom-helpers";

const DEFAULT_MARGIN = 40;
const ROOT_CLASS = "steiner-export-modal";

interface OpenArgs {
  title: string;
  canvas: NotesCanvas;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS reports "MacIntel" but exposes touch; rough heuristic:
  return ua.includes("Macintosh") && (navigator.maxTouchPoints || 0) > 1;
}

export function showExportModal(args: OpenArgs) {
  // Remove any previous instance.
  document.querySelectorAll("." + ROOT_CLASS).forEach((el) => el.remove());

  const choices: ExportOptions = {
    scope: "visible",
    margin: DEFAULT_MARGIN,
    format: "png",
    scale: 1,
    includeBackground: true,
  };

  const labelStyle: Partial<CSSStyleDeclaration> = {
    fontSize: "12px",
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: "6px",
  };

  function makeSegBtn(value: string, label: string, active: boolean): HTMLButtonElement {
    const b = h("button", {
      attrs: { "data-value": value, type: "button" },
      style: {
        flex: "1",
        padding: "8px 12px",
        border: "1px solid #d0d0d8",
        background: active ? "#0f0f0f" : "#fff",
        color: active ? "#fff" : "#0f0f0f",
        fontSize: "13px",
        fontWeight: active ? "600" : "500",
        cursor: "pointer",
        fontFamily: "inherit",
      },
      children: [label],
    });
    return b;
  }

  function makeSegGroup(group: string, items: { value: string; label: string }[], initial: string, onChange: (v: string) => void): HTMLDivElement {
    const wrap = h("div", {
      attrs: { "data-group": group },
      style: { display: "flex", borderRadius: "8px", overflow: "hidden", border: "1px solid #d0d0d8" },
    });
    const buttons: HTMLButtonElement[] = [];
    items.forEach((item, i) => {
      const btn = makeSegBtn(item.value, item.label, item.value === initial);
      btn.style.borderLeft = i === 0 ? "none" : "1px solid #d0d0d8";
      btn.style.borderTop = "none";
      btn.style.borderRight = "none";
      btn.style.borderBottom = "none";
      btn.addEventListener("click", () => {
        for (const b of buttons) {
          const isActive = b === btn;
          b.style.background = isActive ? "#0f0f0f" : "#fff";
          b.style.color = isActive ? "#fff" : "#0f0f0f";
          b.style.fontWeight = isActive ? "600" : "500";
        }
        onChange(item.value);
      });
      buttons.push(btn);
      wrap.appendChild(btn);
    });
    return wrap;
  }

  // === Scope ===
  const marginInput = h("input", {
    attrs: { type: "number", min: "0", max: "500", step: "10", value: String(DEFAULT_MARGIN) },
    style: { width: "70px", padding: "6px 8px", border: "1px solid #d0d0d8", borderRadius: "6px", fontSize: "13px", fontFamily: "inherit" },
  }) as HTMLInputElement;
  marginInput.addEventListener("input", () => {
    const v = parseInt(marginInput.value, 10);
    choices.margin = Number.isFinite(v) && v >= 0 ? v : 0;
  });
  const marginRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", fontSize: "13px", color: "#444" },
    children: [h("span", { children: ["Margin"] }), marginInput, h("span", { style: { color: "#888" }, children: ["px"] })],
  });

  const scopeSection = h("div", {
    style: { marginBottom: "16px" },
    children: [
      h("div", { style: labelStyle, children: ["Scope"] }),
      makeSegGroup("scope", [
        { value: "visible", label: "Visible window" },
        { value: "all", label: "All content" },
      ], choices.scope, (v) => { choices.scope = v as ExportScope; applyVisibility(); }),
      marginRow,
    ],
  });

  // === Format ===
  const formatSection = h("div", {
    style: { marginBottom: "16px" },
    children: [
      h("div", { style: labelStyle, children: ["Format"] }),
      makeSegGroup("format", [
        { value: "steiner", label: ".steiner" },
        { value: "png", label: "PNG" },
        { value: "jpg", label: "JPG" },
        { value: "pdf", label: "PDF" },
      ], choices.format, (v) => { choices.format = v as ExportFormat; applyVisibility(); }),
    ],
  });

  // === Scale ===
  const scaleSection = h("div", {
    style: { marginBottom: "16px" },
    children: [
      h("div", { style: labelStyle, children: ["Scale"] }),
      makeSegGroup("scale", [
        { value: "1", label: "1×" },
        { value: "2", label: "2×" },
        { value: "3", label: "3×" },
      ], String(choices.scale), (v) => { choices.scale = (parseInt(v, 10) as ExportScale); }),
    ],
  });

  // === Background toggle ===
  const bgToggle = h("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  bgToggle.checked = choices.includeBackground;
  bgToggle.addEventListener("change", () => { choices.includeBackground = bgToggle.checked; });
  const bgSection = h("label", {
    style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px", fontSize: "13px", color: "#444", cursor: "pointer" },
    children: [bgToggle, h("span", { children: ["Include background"] })],
  });

  // === Buttons ===
  const cancelBtn = h("button", {
    style: { padding: "9px 16px", border: "1px solid #d0d0d8", background: "#fff", color: "#0f0f0f", borderRadius: "8px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" },
    children: ["Cancel"],
  });
  const exportBtn = h("button", {
    style: { padding: "9px 18px", border: "none", background: "#0f0f0f", color: "#fff", borderRadius: "8px", fontSize: "13px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit" },
    children: ["Export"],
  });
  const actions = h("div", {
    style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" },
    children: [cancelBtn, exportBtn],
  });

  const titleEl = h("div", {
    style: { fontSize: "16px", fontWeight: "600", marginBottom: "16px", color: "#0f0f0f" },
    children: ["Export — " + (args.title || "Session")],
  });

  const card = h("div", {
    style: {
      background: "#fff", borderRadius: "12px", padding: "20px 22px",
      width: "min(420px, 92vw)", boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    },
    children: [titleEl, scopeSection, formatSection, scaleSection, bgSection, actions],
  });

  const overlay = h("div", {
    style: {
      position: "fixed", inset: "0", background: "rgba(15,15,15,0.55)",
      zIndex: "10000", display: "flex", alignItems: "center", justifyContent: "center",
    },
    children: [card],
  });
  overlay.classList.add(ROOT_CLASS);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Enter") {
      const t = document.activeElement;
      const inInput = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
      if (!inInput) { e.preventDefault(); void runExport(); }
    }
  }
  document.addEventListener("keydown", onKey);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  exportBtn.addEventListener("click", () => { void runExport(); });

  applyVisibility();

  function applyVisibility() {
    marginRow.style.display = choices.scope === "all" && choices.format !== "steiner" ? "" : "none";
    scopeSection.style.display = choices.format === "steiner" ? "none" : "";
    scaleSection.style.display = choices.format === "steiner" ? "none" : "";
    bgSection.style.display = choices.format === "steiner" ? "none" : "";
  }

  async function runExport() {
    const restore = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = "Exporting…";
    try {
      const bytes = await exportCanvas(args.canvas, choices);
      const fileName = `${sanitize(args.title || "session")}.${extensionForFormat(choices.format)}`;
      await deliver(bytes, fileName, choices.format);
      close();
    } catch (err) {
      console.error("[steiner] export failed", err);
      exportBtn.textContent = "Export failed";
      setTimeout(() => {
        exportBtn.disabled = false;
        exportBtn.textContent = restore || "Export";
      }, 1800);
    }
  }

  document.body.appendChild(overlay);
}

function sanitize(name: string): string {
  return (name || "session").replace(/[\/\\:*?"<>|]/g, "-").slice(0, 120) || "session";
}

function filterForFormat(fmt: ExportFormat): { name: string; extensions: string[] }[] {
  switch (fmt) {
    case "png": return [{ name: "PNG", extensions: ["png"] }];
    case "jpg": return [{ name: "JPEG", extensions: ["jpg", "jpeg"] }];
    case "pdf": return [{ name: "PDF", extensions: ["pdf"] }];
    case "steiner": return [{ name: "Steiner Notebook", extensions: ["steiner"] }];
  }
}

async function deliver(bytes: Uint8Array, fileName: string, format: ExportFormat): Promise<void> {
  if (IS_TAURI) {
    if (isIOS()) {
      // TS 5.7+ types Uint8Array as generic over its backing buffer, so it
      // doesn't satisfy BlobPart (which requires an ArrayBuffer-backed view).
      // The runtime accepts it fine — cast through BlobPart to reflect that.
      const file = new File([bytes as BlobPart], fileName, { type: mimeForFormat(format) });
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[] }) => Promise<void> };
      if (!(nav.canShare && nav.canShare({ files: [file] }) && nav.share)) {
        throw new Error("Web Share API unavailable for this file");
      }
      try {
        await nav.share({ files: [file] });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err.name === "AbortError" || /aborted|cancel/i.test(err.message || "")) return;
        throw e;
      }
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filePath = await save({ defaultPath: fileName, filters: filterForFormat(format) });
    if (!filePath) return; // user cancelled
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("write_binary_file", { path: filePath, bytes: Array.from(bytes) });
    return;
  }

  // Browser fallback (vite dev server, GitHub Pages web build, etc.)
  const blob = new Blob([bytes as BlobPart], { type: mimeForFormat(format) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
