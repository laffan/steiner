import { api, DEFAULT_ASK_WORD_LIMIT, DEFAULT_MODEL, MODELS } from "../api";
import { h } from "./dom-helpers";
import { createSyncTab } from "./sync-tab";

type TabId = "general" | "sync";

export function createSettingsModal() {
  let onClose: (() => void) | null = null;
  let activeTab: TabId = "general";

  // --- General tab controls ---

  const apiInput = h("input", {
    attrs: { type: "password", placeholder: "sk-ant-…" },
    style: {
      width: "100%",
      padding: "10px 12px",
      border: "1px solid #ddd",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "monospace",
      outline: "none",
    },
  }) as HTMLInputElement;

  const wordLimitInput = h("input", {
    attrs: { type: "number", min: "20", max: "2000", step: "10" },
    style: {
      width: "120px",
      padding: "8px 10px",
      border: "1px solid #ddd",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "inherit",
      outline: "none",
    },
  }) as HTMLInputElement;
  wordLimitInput.value = String(DEFAULT_ASK_WORD_LIMIT);

  const modelSelect = h("select", {
    style: {
      padding: "8px 10px",
      border: "1px solid #ddd",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "inherit",
      outline: "none",
      background: "#fff",
      cursor: "pointer",
    },
  }) as HTMLSelectElement;
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = DEFAULT_MODEL;

  const generalStatus = h("div", {
    style: { fontSize: "12px", color: "#666", minHeight: "16px" },
  });

  const clearKeyBtn = h("button", {
    style: {
      padding: "8px 12px",
      border: "1px solid #ddd",
      background: "transparent",
      color: "#a33",
      borderRadius: "8px",
      fontSize: "12px",
      cursor: "pointer",
    },
    children: ["Clear stored key"],
    onClick: async () => {
      await api.setApiKey("");
      apiInput.value = "";
      generalStatus.textContent = "Cleared.";
    },
  });

  const generalPane = h("div", {
    style: { display: "flex", flexDirection: "column", gap: "10px" },
    children: [
      h("label", { style: { fontSize: "13px", color: "#444" }, children: ["Anthropic API key"] }),
      apiInput,
      h("label", {
        style: { fontSize: "13px", color: "#444", marginTop: "4px" },
        children: ["Ask Claude model"],
      }),
      modelSelect,
      h("label", {
        style: { fontSize: "13px", color: "#444", marginTop: "4px" },
        children: ["Ask Claude word limit"],
      }),
      h("div", {
        style: { display: "flex", alignItems: "center", gap: "10px" },
        children: [
          wordLimitInput,
          h("span", {
            style: { fontSize: "12px", color: "#888" },
            children: ["words. Used in the seed prompt."],
          }),
        ],
      }),
      h("div", {
        style: { display: "flex", justifyContent: "flex-start" },
        children: [clearKeyBtn],
      }),
      generalStatus,
    ],
  });

  // --- Sync tab ---

  const syncTab = createSyncTab();

  // --- Tab strip + container ---

  const tabStrip = h("div", {
    style: {
      display: "flex",
      borderBottom: "1px solid #e5e5e5",
      marginBottom: "14px",
    },
  });

  function makeTab(id: TabId, label: string): HTMLButtonElement {
    return h("button", {
      style: {
        flex: "0 0 auto",
        padding: "8px 14px",
        fontSize: "13px",
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "#888",
        borderBottom: "2px solid transparent",
        marginBottom: "-1px",
        fontFamily: "inherit",
      },
      children: [label],
      onClick: () => {
        activeTab = id;
        renderTabs();
      },
    }) as HTMLButtonElement;
  }

  const generalTabBtn = makeTab("general", "General");
  const syncTabBtn = makeTab("sync", "Sync");
  tabStrip.appendChild(generalTabBtn);
  tabStrip.appendChild(syncTabBtn);

  const contentPane = h("div", {
    style: { display: "flex", flexDirection: "column" },
  });

  function renderTabs() {
    const activeStyle = (active: boolean): Partial<CSSStyleDeclaration> => ({
      color: active ? "#111" : "#888",
      borderBottom: active ? "2px solid #111" : "2px solid transparent",
    });
    Object.assign(generalTabBtn.style, activeStyle(activeTab === "general"));
    Object.assign(syncTabBtn.style, activeStyle(activeTab === "sync"));
    contentPane.innerHTML = "";
    contentPane.appendChild(activeTab === "general" ? generalPane : syncTab.el);
    if (activeTab === "sync") void syncTab.refresh();
  }

  const saveBtn = h("button", {
    style: {
      padding: "10px 16px",
      border: "none",
      background: "#0f0f0f",
      color: "#fff",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
    },
    children: ["Save"],
    onClick: async () => {
      // Save covers General-tab fields. The Sync tab persists immediately on
      // Link / Unlink / Sync now and doesn't need a Save round-trip.
      const key = apiInput.value.trim();
      const parsed = parseInt(wordLimitInput.value, 10);
      const limit = Number.isFinite(parsed) ? parsed : DEFAULT_ASK_WORD_LIMIT;
      const model = modelSelect.value || DEFAULT_MODEL;
      try {
        if (key) await api.setApiKey(key);
        await api.setAskWordLimit(limit);
        await api.setAskModel(model);
        generalStatus.textContent = "Saved.";
        setTimeout(close, 600);
      } catch (err) {
        generalStatus.textContent = `Failed: ${err}`;
      }
    },
  });

  const closeBtn = h("button", {
    style: {
      padding: "10px 16px",
      border: "1px solid #ddd",
      background: "#fff",
      color: "#0f0f0f",
      borderRadius: "8px",
      fontSize: "14px",
      cursor: "pointer",
    },
    children: ["Close"],
    onClick: () => close(),
  });

  const card = h("div", {
    style: {
      width: "min(480px, 92vw)",
      maxHeight: "min(640px, 90vh)",
      background: "#fff",
      borderRadius: "12px",
      padding: "20px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
      overflow: "hidden",
    },
    children: [
      h("h2", { style: { fontSize: "16px", fontWeight: "600", margin: "0" }, children: ["Settings"] }),
      tabStrip,
      h("div", {
        style: { flex: "1", overflowY: "auto" },
        children: [contentPane],
      }),
      h("div", {
        style: { display: "flex", gap: "8px", justifyContent: "flex-end" },
        children: [closeBtn, saveBtn],
      }),
    ],
  });

  const overlay = h("div", {
    style: {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.4)",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "9999",
    },
    children: [card],
    onClick: (e: MouseEvent) => {
      if (e.target === overlay) close();
    },
  });

  function close() {
    overlay.style.display = "none";
    if (onClose) onClose();
  }

  async function open(cb?: () => void) {
    onClose = cb || null;
    activeTab = "general";
    try {
      const s = await api.getSettings();
      apiInput.value = "";
      wordLimitInput.value = String(s.ask_word_limit ?? DEFAULT_ASK_WORD_LIMIT);
      modelSelect.value = s.ask_model ?? DEFAULT_MODEL;
      generalStatus.textContent = s.anthropic_api_key
        ? `Key on file: ${s.anthropic_api_key}`
        : "No key set.";
    } catch (err) {
      generalStatus.textContent = `Could not load: ${err}`;
    }
    renderTabs();
    overlay.style.display = "flex";
    setTimeout(() => apiInput.focus(), 50);
  }

  return { el: overlay, open, close };
}
