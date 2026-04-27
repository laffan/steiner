// Sync tab inside the settings modal. Handles the Dropbox OAuth (PKCE) flow
// from the renderer side: generates verifier/challenge, opens the auth URL in
// the system browser, listens for the `steiner://auth/callback` deep link,
// and trades the auth code for tokens via the backend command.

import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { api, DROPBOX_APP_KEY, DROPBOX_REDIRECT_URI } from "../api";
import { h } from "./dom-helpers";

const AUTH_BASE = "https://www.dropbox.com/oauth2/authorize";

interface PendingAuth {
  verifier: string;
  state: string;
}

export function createSyncTab() {
  const status = h("div", {
    style: { fontSize: "13px", color: "#444" },
    children: ["…"],
  });

  const lastSync = h("div", {
    style: { fontSize: "11px", color: "#888", marginTop: "2px" },
  });

  const linkBtn = h("button", {
    style: actionBtnStyle("#0f0f0f", "#fff"),
    children: ["Link Dropbox"],
  }) as HTMLButtonElement;

  const unlinkBtn = h("button", {
    style: actionBtnStyle("transparent", "#a33", "1px solid #ddd"),
    children: ["Unlink"],
  }) as HTMLButtonElement;

  const syncBtn = h("button", {
    style: actionBtnStyle("#0f0f0f", "#fff"),
    children: ["Sync now"],
  }) as HTMLButtonElement;

  const message = h("div", {
    style: { fontSize: "12px", color: "#666", minHeight: "16px", marginTop: "4px" },
  });

  let pending: PendingAuth | null = null;
  let listening = false;

  async function ensureListener() {
    if (listening) return;
    listening = true;
    // The deep-link plugin emits `deep-link://new-url` as the underlying
    // Tauri event whenever a registered scheme URL is delivered. We listen
    // directly rather than going through the plugin's onOpenUrl wrapper —
    // that wrapper's been observed to miss deliveries in dev mode.
    try {
      await listen<string[]>("deep-link://new-url", (e) => {
        console.log("[steiner] deep-link://new-url", e.payload);
        for (const url of e.payload || []) handleCallback(url);
      });
    } catch (err) {
      console.warn("[steiner] deep-link listener failed", err);
    }
    // Belt-and-suspenders: a Rust on_open_url hook also re-emits the URLs
    // on `steiner://deep-link` in case the plugin event channel doesn't
    // reach the renderer in some configuration.
    try {
      await listen<string[]>("steiner://deep-link", (e) => {
        console.log("[steiner] steiner://deep-link backup", e.payload);
        for (const url of e.payload || []) handleCallback(url);
      });
    } catch (err) {
      console.warn("[steiner] backup listener failed", err);
    }
  }

  async function handleCallback(rawUrl: string) {
    console.log("[steiner] handleCallback", { rawUrl, hasPending: !!pending });
    if (!pending) {
      message.textContent = "Got auth callback but no pending request — click Link Dropbox first.";
      return;
    }
    if (!rawUrl.startsWith("steiner:")) return;
    // Normalize to a parseable form — different runtimes hand back the URL
    // with subtly different host/pathname splits. Pull `code` / `state` /
    // `error` straight out of the query string instead of trusting URL().
    const queryStart = rawUrl.indexOf("?");
    if (queryStart < 0) {
      message.textContent = "Auth callback missing query — try again.";
      return;
    }
    const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    if (err) {
      message.textContent = `Auth failed: ${err}`;
      pending = null;
      return;
    }
    if (!code || !state) {
      message.textContent = "Auth response missing code or state — try again.";
      pending = null;
      return;
    }
    if (state !== pending.state) {
      message.textContent = "Auth state mismatch — try again.";
      pending = null;
      return;
    }
    const verifier = pending.verifier;
    pending = null;
    message.textContent = "Exchanging code…";
    try {
      const s = await api.dropboxExchangeCode(code, verifier, DROPBOX_APP_KEY, DROPBOX_REDIRECT_URI);
      renderStatus(s);
      message.textContent = "Linked.";
    } catch (e) {
      message.textContent = `Exchange failed: ${e}`;
    }
  }

  linkBtn.addEventListener("click", async () => {
    if (!DROPBOX_APP_KEY) {
      message.textContent = "VITE_DROPBOX_APP_KEY not configured. Set it in your .env and rebuild.";
      return;
    }
    try {
      await ensureListener();
      const verifier = generateVerifier();
      const challenge = await sha256Base64Url(verifier);
      const stateTok = randomBase64Url(16);
      pending = { verifier, state: stateTok };
      const url = new URL(AUTH_BASE);
      url.searchParams.set("client_id", DROPBOX_APP_KEY);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", DROPBOX_REDIRECT_URI);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("token_access_type", "offline");
      url.searchParams.set("state", stateTok);
      message.textContent = "Opened Dropbox in your browser. Approve, then return here.";
      await openUrl(url.toString());
    } catch (e) {
      message.textContent = `Could not start auth: ${e}`;
      pending = null;
    }
  });

  unlinkBtn.addEventListener("click", async () => {
    try {
      await api.dropboxDisconnect();
      const s = await api.dropboxStatus();
      renderStatus(s);
      message.textContent = "Unlinked.";
    } catch (e) {
      message.textContent = `Unlink failed: ${e}`;
    }
  });

  syncBtn.addEventListener("click", async () => {
    if (!DROPBOX_APP_KEY) {
      message.textContent = "VITE_DROPBOX_APP_KEY not configured.";
      return;
    }
    syncBtn.disabled = true;
    message.textContent = "Syncing…";
    try {
      const result = await api.dropboxSyncNow(DROPBOX_APP_KEY);
      message.textContent =
        `Done — ${result.uploaded} up, ${result.downloaded} down, ${result.skipped} unchanged.`;
      const s = await api.dropboxStatus();
      renderStatus(s);
    } catch (e) {
      message.textContent = `Sync failed: ${e}`;
    } finally {
      syncBtn.disabled = false;
    }
  });

  function renderStatus(s: { linked: boolean; account_email: string | null; last_sync: string | null }) {
    if (s.linked) {
      const who = s.account_email || "Dropbox account";
      status.textContent = `Linked: ${who}`;
      linkBtn.style.display = "none";
      unlinkBtn.style.display = "inline-flex";
      syncBtn.style.display = "inline-flex";
      lastSync.textContent = s.last_sync ? `Last sync: ${formatTimestamp(s.last_sync)}` : "Never synced.";
    } else {
      status.textContent = "Not linked.";
      linkBtn.style.display = "inline-flex";
      unlinkBtn.style.display = "none";
      syncBtn.style.display = "none";
      lastSync.textContent = "";
    }
  }

  async function refresh() {
    try {
      const s = await api.dropboxStatus();
      renderStatus(s);
    } catch (e) {
      status.textContent = `Could not load status: ${e}`;
    }
    // Register listeners eagerly so a deep-link callback that arrives before
    // the user re-clicks Link is still caught.
    void ensureListener();
  }

  const root = h("div", {
    style: { display: "flex", flexDirection: "column", gap: "10px" },
    children: [
      h("div", {
        style: { fontSize: "12px", color: "#666", lineHeight: "1.5" },
        children: [
          "Sync session files to a Dropbox app folder so they round-trip across your devices. v1 is manual — push uploads everything, pull grabs anything newer on Dropbox. Last-write-wins on `updated_at`.",
        ],
      }),
      h("div", {
        style: { display: "flex", flexDirection: "column", gap: "2px" },
        children: [status, lastSync],
      }),
      h("div", {
        style: { display: "flex", gap: "8px", flexWrap: "wrap" },
        children: [linkBtn, syncBtn, unlinkBtn],
      }),
      message,
    ],
  });

  void refresh();

  return { el: root, refresh };
}

function actionBtnStyle(bg: string, color: string, border = "none"): Partial<CSSStyleDeclaration> {
  return {
    padding: "8px 14px",
    border,
    background: bg,
    color,
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    display: "none",
    fontFamily: "inherit",
  };
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// --- PKCE helpers ---

function generateVerifier(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

async function sha256Base64Url(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
