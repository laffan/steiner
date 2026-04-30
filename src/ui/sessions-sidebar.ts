import { api, DEFAULT_ASK_WORD_LIMIT, DEFAULT_MODEL, MODELS, type SessionMeta } from "../api";
import { h } from "./dom-helpers";

function modelLabel(id: string | null | undefined): string {
  const resolved = id || DEFAULT_MODEL;
  return MODELS.find((m) => m.id === resolved)?.label || resolved;
}

interface Options {
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  onExport: (id: string) => void;
  getActiveId: () => string | null;
}

export function createSessionsSidebar(opts: Options) {
  const list = h("div", {
    style: {
      flex: "1",
      overflowY: "auto",
      padding: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    },
  });

  const newBtn = h("button", {
    style: {
      padding: "10px 12px",
      border: "none",
      background: "#0f0f0f",
      color: "#fff",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      width: "100%",
    },
    children: ["+ New session"],
    onClick: () => opts.onCreate(),
  });

  const settingsBtn = h("button", {
    style: {
      padding: "10px 12px",
      border: "1px solid #ddd",
      background: "transparent",
      color: "#0f0f0f",
      borderRadius: "8px",
      fontSize: "13px",
      cursor: "pointer",
      width: "100%",
    },
    children: ["Settings"],
    onClick: () => opts.onOpenSettings(),
  });

  const settingsStatus = h("div", {
    style: {
      fontSize: "11px",
      color: "#888",
      textAlign: "center",
      marginTop: "-2px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    children: ["…"],
  });

  const header = h("div", {
    style: {
      padding: "12px",
      borderBottom: "1px solid #e5e5e5",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
    },
    children: [newBtn, settingsBtn, settingsStatus],
  });

  const root = h("div", {
    style: {
      flex: "1",
      minHeight: "0",
      background: "#fafafa",
      display: "flex",
      flexDirection: "column",
    },
    children: [header, list],
  });

  let metas: SessionMeta[] = [];
  let archiveOpen = false;

  function makeRow(m: SessionMeta, archived: boolean): HTMLElement {
    const isActive = m.id === opts.getActiveId();
    const item = h("div", {
      style: {
        padding: "10px 12px",
        borderRadius: "8px",
        cursor: "pointer",
        background: isActive ? "#e8f0fe" : "transparent",
        border: isActive ? "1px solid #c7d8f3" : "1px solid transparent",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        opacity: archived ? "0.7" : "1",
      },
      onClick: () => opts.onSelect(m.id),
    });

    const titleEl = h("div", {
      style: {
        fontSize: "13px",
        fontWeight: "500",
        color: "#111",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      children: [m.title || "Untitled"],
    });
    titleEl.title = "Double-click to rename";
    titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(m, titleEl);
    });

    const meta = h("div", {
      style: { fontSize: "11px", color: "#888" },
      children: [formatDate(m.updated_at)],
    });

    const actions = h("div", {
      style: {
        display: "flex",
        gap: "4px",
        marginTop: "4px",
        opacity: "0",
        transition: "opacity 0.1s",
      },
    });

    const renameBtn = makeRowBtn("Rename", () => startRename(m, titleEl));
    const archiveBtn = makeRowBtn(archived ? "Restore" : "Archive", async () => {
      await api.setSessionArchived(m.id, !archived);
      await reload();
    });
    const exportBtn = makeRowBtn("Export", () => opts.onExport(m.id));
    const delBtn = makeRowBtn("Delete", async () => {
      if (!confirm(`Delete "${m.title}"? This is permanent.`)) return;
      await api.deleteSession(m.id);
      await reload();
    });
    delBtn.style.color = "#a33";

    actions.appendChild(renameBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(delBtn);

    item.addEventListener("mouseenter", () => (actions.style.opacity = "1"));
    item.addEventListener("mouseleave", () => (actions.style.opacity = "0"));

    item.appendChild(titleEl);
    item.appendChild(meta);
    item.appendChild(actions);
    return item;
  }

  function makeRowBtn(label: string, onClick: () => void): HTMLButtonElement {
    return h("button", {
      style: {
        padding: "2px 6px",
        fontSize: "11px",
        border: "none",
        background: "transparent",
        color: "#444",
        cursor: "pointer",
      },
      children: [label],
      onClick: (e: Event) => {
        e.stopPropagation();
        onClick();
      },
    }) as HTMLButtonElement;
  }

  function startRename(m: SessionMeta, titleEl: HTMLElement) {
    const input = h("input", {
      attrs: { type: "text", value: m.title || "" },
      style: {
        fontSize: "13px",
        fontWeight: "500",
        color: "#111",
        width: "100%",
        padding: "1px 4px",
        border: "1px solid #c7d8f3",
        borderRadius: "4px",
        outline: "none",
        background: "#fff",
        fontFamily: "inherit",
      },
    }) as HTMLInputElement;
    input.value = m.title || "";

    titleEl.replaceWith(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (next && next !== m.title) {
        try {
          await api.updateSessionTitle(m.id, next);
          await reload();
        } catch {
          await reload();
        }
      } else {
        await reload();
      }
    };
    const cancel = async () => {
      if (committed) return;
      committed = true;
      await reload();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", () => commit());
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  function render() {
    list.innerHTML = "";
    const active = metas.filter((m) => !m.archived);
    const archived = metas.filter((m) => m.archived);

    if (active.length === 0) {
      list.appendChild(
        h("div", {
          style: { padding: "16px", color: "#888", fontSize: "13px", textAlign: "center" },
          children: ["No sessions yet."],
        }),
      );
    } else {
      for (const m of active) list.appendChild(makeRow(m, false));
    }

    if (archived.length > 0) {
      const folder = h("div", {
        style: {
          marginTop: "12px",
          padding: "6px 10px",
          fontSize: "11px",
          color: "#666",
          fontWeight: "500",
          cursor: "pointer",
          userSelect: "none",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        },
        children: [
          h("span", {
            style: { fontSize: "9px", color: "#888" },
            children: [archiveOpen ? "▾" : "▸"],
          }),
          h("span", { children: [`Archive (${archived.length})`] }),
        ],
        onClick: () => {
          archiveOpen = !archiveOpen;
          render();
        },
      });
      list.appendChild(folder);
      if (archiveOpen) {
        for (const m of archived) list.appendChild(makeRow(m, true));
      }
    }
  }

  async function reload() {
    metas = await api.listSessions();
    render();
  }

  async function refreshSettings() {
    try {
      const s = await api.getSettings();
      const model = modelLabel(s.ask_model);
      const limit = s.ask_word_limit ?? DEFAULT_ASK_WORD_LIMIT;
      settingsStatus.textContent = `${model} · ${limit} words`;
    } catch {
      settingsStatus.textContent = "";
    }
  }

  return { el: root, reload, render, refreshSettings };
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const ms = now - d.getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}
