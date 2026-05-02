use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WindowEvent};
#[cfg(desktop)]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};
use uuid::Uuid;

mod dropbox;

const DEFAULT_MODEL: &str = "claude-opus-4-7";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";

const WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const CANVAS_LABEL: &str = "canvas";

/// Configuration for a sidebar browser tab — the webview label, the
/// canonical home URL, and the list of host prefixes whose URLs we'll
/// remember between launches.
#[cfg(desktop)]
struct BrowserKind {
    /// Tauri webview label (e.g. "chat", "wiki").
    label: &'static str,
    /// Where we land if the user has no saved URL.
    home: &'static str,
    /// URL prefixes that count as "this site" for last-URL tracking.
    /// Off-domain navigations (logins, redirects) are not persisted.
    allowed_prefixes: &'static [&'static str],
}

#[cfg(desktop)]
const BROWSERS: &[BrowserKind] = &[
    BrowserKind {
        label: "chat",
        home: "https://claude.ai/recents",
        allowed_prefixes: &["https://claude.ai", "https://www.claude.ai"],
    },
    BrowserKind {
        label: "wiki",
        home: "https://en.wikipedia.org/",
        allowed_prefixes: &[
            "https://wikipedia.org",
            "https://www.wikipedia.org",
            "https://en.wikipedia.org",
            "https://en.m.wikipedia.org",
        ],
    },
];

#[cfg(desktop)]
fn browser_kind(label: &str) -> Option<&'static BrowserKind> {
    BROWSERS.iter().find(|b| b.label == label)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CanvasState {
    #[serde(default)]
    pub shapes: serde_json::Value,
    #[serde(default)]
    pub snippet_meta: serde_json::Value,
    #[serde(default)]
    pub flow_edges: serde_json::Value,
    #[serde(default)]
    pub shape_chats: serde_json::Value,
    #[serde(default)]
    pub transcripts: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub model: String,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub canvas: CanvasState,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub model: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub anthropic_api_key: Option<String>,
    #[serde(default)]
    pub ask_word_limit: Option<u32>,
    #[serde(default)]
    pub ask_model: Option<String>,
    /// Prefix put before the term in the Ask Claude seed prompt.
    /// Default: "Can you summarize". Format: `{prefix} {term}{suffix}. {word_limit_request}`.
    #[serde(default)]
    pub ask_prompt_prefix: Option<String>,
    /// Suffix appended to the term in the Ask Claude seed prompt. Default: "".
    #[serde(default)]
    pub ask_prompt_suffix: Option<String>,
    #[serde(default)]
    pub dropbox_access_token: Option<String>,
    #[serde(default)]
    pub dropbox_refresh_token: Option<String>,
    #[serde(default)]
    pub dropbox_account_email: Option<String>,
    #[serde(default)]
    pub dropbox_last_sync: Option<String>,
    #[serde(default)]
    pub last_claude_url: Option<String>,
    #[serde(default)]
    pub last_wiki_url: Option<String>,
}

pub struct AppState {
    pub current_stream: Mutex<Option<String>>, // session_id of in-flight stream
    /// Labels of sidebar browser webviews already added to the main window.
    /// Keyed by `BrowserKind::label`. Subsequent show calls just reposition
    /// the existing webview.
    #[cfg(desktop)]
    pub created_browsers: Mutex<std::collections::HashSet<String>>,
}

// --- Path helpers ---

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
}

pub(crate) fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("sessions");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub(crate) fn session_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir(app)?.join(format!("{}.json", id)))
}

// --- Settings ---

pub(crate) fn read_settings(app: &AppHandle) -> Settings {
    let Ok(p) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(raw) = fs::read_to_string(&p) else {
        return Settings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(crate) fn write_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&p, raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    let mut s = read_settings(&app);
    if let Some(k) = s.anthropic_api_key.as_deref() {
        // Don't expose the full key; surface presence only.
        let masked = if k.len() > 8 {
            format!("{}…{}", &k[..4], &k[k.len() - 4..])
        } else {
            "set".to_string()
        };
        s.anthropic_api_key = Some(masked);
    }
    // Tokens are sensitive; surface only "set" so the UI can show linked status
    // without ever exposing the actual token to the renderer.
    if s.dropbox_access_token.is_some() {
        s.dropbox_access_token = Some("set".to_string());
    }
    if s.dropbox_refresh_token.is_some() {
        s.dropbox_refresh_token = Some("set".to_string());
    }
    s
}

#[tauri::command]
fn set_api_key(app: AppHandle, key: String) -> Result<(), String> {
    let mut s = read_settings(&app);
    let trimmed = key.trim();
    s.anthropic_api_key = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    write_settings(&app, &s)
}

#[tauri::command]
fn set_ask_word_limit(app: AppHandle, limit: u32) -> Result<(), String> {
    let mut s = read_settings(&app);
    let clamped = limit.clamp(20, 2000);
    s.ask_word_limit = Some(clamped);
    write_settings(&app, &s)
}

#[tauri::command]
fn set_ask_model(app: AppHandle, model: String) -> Result<(), String> {
    let mut s = read_settings(&app);
    let trimmed = model.trim();
    s.ask_model = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    write_settings(&app, &s)
}

#[tauri::command]
fn set_ask_prompt_prefix(app: AppHandle, prefix: String) -> Result<(), String> {
    let mut s = read_settings(&app);
    // Empty string is meaningful (user wants no prefix); only None means
    // "fall back to default" on the frontend. We trim to avoid stray
    // whitespace that would render oddly between prefix and term.
    let trimmed = prefix.trim();
    s.ask_prompt_prefix = Some(trimmed.to_string());
    write_settings(&app, &s)
}

#[tauri::command]
fn set_ask_prompt_suffix(app: AppHandle, suffix: String) -> Result<(), String> {
    let mut s = read_settings(&app);
    // Trailing whitespace is fine to drop, but leading whitespace could be
    // load-bearing (e.g. the user wants " — " vs "—"). Trim trailing only.
    let trimmed = suffix.trim_end();
    s.ask_prompt_suffix = Some(trimmed.to_string());
    write_settings(&app, &s)
}

#[tauri::command]
fn is_desktop() -> bool {
    cfg!(desktop)
}

// --- Sidebar browser child webviews ---
//
// Desktop only: each browser tab in the sidebar (Chat = claude.ai, Wiki =
// wikipedia.org) gets its own WKWebView parented under the main window and
// positioned by the frontend to overlay the active tab's area. Webviews are
// created lazily on first show and then just repositioned on subsequent
// calls. iOS has no equivalent — those tabs are hidden in the UI.

#[cfg(desktop)]
fn last_url_for(s: &Settings, kind: &BrowserKind) -> Option<String> {
    match kind.label {
        "chat" => s.last_claude_url.clone(),
        "wiki" => s.last_wiki_url.clone(),
        _ => None,
    }
}

#[cfg(desktop)]
fn save_last_url_for(app: &AppHandle, kind: &BrowserKind, url: &str) -> Result<(), String> {
    if !kind.allowed_prefixes.iter().any(|p| url.starts_with(p)) {
        return Ok(());
    }
    let mut s = read_settings(app);
    let slot = match kind.label {
        "chat" => &mut s.last_claude_url,
        "wiki" => &mut s.last_wiki_url,
        _ => return Ok(()),
    };
    if slot.as_deref() == Some(url) {
        return Ok(());
    }
    *slot = Some(url.to_string());
    write_settings(app, &s)
}

#[cfg(desktop)]
fn ensure_browser_webview(
    app: &AppHandle,
    kind: &'static BrowserKind,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState missing".to_string())?;
    let mut created = state
        .created_browsers
        .lock()
        .map_err(|e| e.to_string())?;
    if created.contains(kind.label) {
        return Ok(());
    }

    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let initial_url = last_url_for(&read_settings(app), kind)
        .filter(|u| kind.allowed_prefixes.iter().any(|p| u.starts_with(p)))
        .unwrap_or_else(|| kind.home.to_string());

    let fallback = kind.home;
    let parsed_url: tauri::Url = initial_url
        .parse()
        .unwrap_or_else(|_| fallback.parse().expect("static fallback URL parses"));
    let app_for_nav = app.clone();
    let builder = WebviewBuilder::new(kind.label, WebviewUrl::External(parsed_url)).on_navigation(
        move |url| {
            let s = url.to_string();
            let _ = save_last_url_for(&app_for_nav, kind, &s);
            true
        },
    );

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;

    created.insert(kind.label.to_string());
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn show_browser_webview(
    app: AppHandle,
    kind: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let bk = browser_kind(&kind).ok_or_else(|| format!("unknown browser kind: {}", kind))?;
    ensure_browser_webview(&app, bk, x, y, w, h)?;
    let webview = app
        .get_webview(bk.label)
        .ok_or_else(|| format!("{} webview not found", bk.label))?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn hide_browser_webview(app: AppHandle, kind: String) -> Result<(), String> {
    let bk = browser_kind(&kind).ok_or_else(|| format!("unknown browser kind: {}", kind))?;
    if let Some(webview) = app.get_webview(bk.label) {
        // Park offscreen at zero size; recreating/destroying webviews mid-run
        // is finicky, so we keep it alive and just hide it.
        webview
            .set_size(LogicalSize::new(1.0, 1.0))
            .map_err(|e| e.to_string())?;
        webview
            .set_position(LogicalPosition::new(-10000.0, -10000.0))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Mobile shims so the frontend can call the same commands on every platform.
#[cfg(not(desktop))]
#[tauri::command]
fn show_browser_webview(_kind: String, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<(), String> {
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn hide_browser_webview(_kind: String) -> Result<(), String> {
    Ok(())
}

// --- Sessions ---

pub(crate) fn read_session(app: &AppHandle, id: &str) -> Result<Session, String> {
    let p = session_path(app, id)?;
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_session(app: &AppHandle, s: &Session) -> Result<(), String> {
    let p = session_path(app, &s.id)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&p, raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_sessions(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    let dir = sessions_dir(&app)?;
    let mut metas: Vec<SessionMeta> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(s): Result<Session, _> = serde_json::from_str(&raw) else {
            continue;
        };
        metas.push(SessionMeta {
            id: s.id,
            title: s.title,
            created_at: s.created_at,
            updated_at: s.updated_at,
            model: s.model,
            archived: s.archived,
        });
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    title: Option<String>,
    model: Option<String>,
) -> Result<Session, String> {
    let now = Utc::now().to_rfc3339();
    let s = Session {
        id: format!("sess_{}", Uuid::new_v4().simple()),
        title: title.unwrap_or_else(|| "New session".to_string()),
        created_at: now.clone(),
        updated_at: now,
        model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        messages: Vec::new(),
        canvas: CanvasState::default(),
        archived: false,
    };
    write_session(&app, &s)?;
    Ok(s)
}

#[tauri::command]
fn get_session(app: AppHandle, id: String) -> Result<Session, String> {
    read_session(&app, &id)
}

#[tauri::command]
fn update_session_title(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let mut s = read_session(&app, &id)?;
    s.title = title;
    s.updated_at = Utc::now().to_rfc3339();
    write_session(&app, &s)
}

#[tauri::command]
fn update_session_model(app: AppHandle, id: String, model: String) -> Result<(), String> {
    let mut s = read_session(&app, &id)?;
    s.model = model;
    s.updated_at = Utc::now().to_rfc3339();
    write_session(&app, &s)
}

#[tauri::command]
fn save_session_canvas(app: AppHandle, id: String, canvas: CanvasState) -> Result<(), String> {
    let mut s = read_session(&app, &id)?;
    s.canvas = canvas;
    s.updated_at = Utc::now().to_rfc3339();
    write_session(&app, &s)
}

#[tauri::command]
fn set_session_archived(app: AppHandle, id: String, archived: bool) -> Result<(), String> {
    let mut s = read_session(&app, &id)?;
    s.archived = archived;
    s.updated_at = Utc::now().to_rfc3339();
    write_session(&app, &s)
}

#[tauri::command]
fn delete_session(app: AppHandle, id: String) -> Result<(), String> {
    let p = session_path(&app, &id)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Write `bytes` to `path`. Used by the export pipeline (and any future
/// binary-write callers) because the @tauri-apps/plugin-fs writer
/// truncates 0-byte files on iOS — routing binary writes through Rust
/// avoids that. Path normalization handles iOS's percent-encoded
/// `file://` URLs from the document picker.
///
/// **Containment.** The Tauri dialog plugin already constrains the user
/// to paths reachable via the system picker, but this command is also
/// invokable directly, so we add defence-in-depth: the resolved path
/// must live under home / app-data / cache / temp. Anything else is
/// rejected before `fs::write` runs.
#[tauri::command]
fn write_binary_file(app: AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    let resolved = normalize_dialog_path(&path);
    let abs = std::path::PathBuf::from(&resolved);
    ensure_path_in_safe_root(&app, &abs)?;
    fs::write(&abs, &bytes).map_err(|e| format!("{} (path: {})", e, resolved))
}

fn ensure_path_in_safe_root(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("write_binary_file: path must be absolute: {}", path.display()));
    }
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(format!("write_binary_file: '..' in path: {}", path.display()));
        }
    }
    let p = app.path();
    let mut allowed: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(d) = p.home_dir() { allowed.push(d); }
    if let Ok(d) = p.app_data_dir() { allowed.push(d); }
    if let Ok(d) = p.app_cache_dir() { allowed.push(d); }
    if let Ok(d) = p.document_dir() { allowed.push(d); }
    if let Ok(d) = p.download_dir() { allowed.push(d); }
    if let Ok(d) = p.desktop_dir() { allowed.push(d); }
    allowed.push(std::env::temp_dir());
    #[cfg(target_os = "macos")]
    {
        allowed.push(std::path::PathBuf::from("/tmp"));
        allowed.push(std::path::PathBuf::from("/private/tmp"));
        allowed.push(std::path::PathBuf::from("/private/var/folders"));
    }
    for root in &allowed {
        if path.starts_with(root) { return Ok(()); }
    }
    Err(format!(
        "write_binary_file: refusing to write outside home/data/temp roots: {}",
        path.display()
    ))
}

/// Strip a `file://` prefix (iOS document picker URLs) and percent-decode
/// the remainder. A bare filesystem path passes through untouched.
fn normalize_dialog_path(raw: &str) -> String {
    let trimmed = raw.strip_prefix("file://").unwrap_or(raw);
    percent_decode(trimmed)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[tauri::command]
fn export_session_markdown(app: AppHandle, id: String) -> Result<String, String> {
    let s = read_session(&app, &id)?;
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", s.title));
    out.push_str(&format!("_Model: {} · Updated: {}_\n\n", s.model, s.updated_at));

    if let Ok(snippets) = serde_json::from_value::<Vec<serde_json::Value>>(
        s.canvas.shapes.clone(),
    ) {
        let texts: Vec<String> = snippets
            .iter()
            .filter_map(|v| v.get("text").and_then(|t| t.as_str()).map(|t| t.to_string()))
            .collect();
        if !texts.is_empty() {
            out.push_str("## Pinned snippets\n\n");
            for t in texts {
                out.push_str(&format!("- {}\n", t.replace('\n', " ")));
            }
            out.push('\n');
        }
    }

    out.push_str("## Conversation\n\n");
    for m in &s.messages {
        let label = if m.role == "user" { "**You**" } else { "**Claude**" };
        out.push_str(&format!("{}\n\n{}\n\n", label, m.content));
    }
    Ok(out)
}

// --- Claude API streaming ---

#[derive(Debug, Serialize)]
struct ApiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Serialize)]
struct ApiRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<ApiMessage<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_config: Option<serde_json::Value>,
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    session_id: String,
    content: String,
) -> Result<String, String> {
    let settings = read_settings(&app);
    let api_key = settings
        .anthropic_api_key
        .ok_or_else(|| "No API key set. Open settings and paste your Anthropic key.".to_string())?;

    // Append user message and persist.
    let mut session = read_session(&app, &session_id)?;
    let user_msg = Message {
        id: format!("msg_{}", Uuid::new_v4().simple()),
        role: "user".to_string(),
        content: content.clone(),
        timestamp: Utc::now().to_rfc3339(),
    };
    session.messages.push(user_msg.clone());
    session.updated_at = Utc::now().to_rfc3339();
    if session.messages.len() == 1 {
        // Auto-title from first user message.
        let snippet: String = content.chars().take(60).collect();
        session.title = snippet.trim().to_string();
    }
    write_session(&app, &session)?;
    let _ = app.emit("session-updated", &session_id);

    let model = session.model.clone();
    let api_messages: Vec<ApiMessage> = session
        .messages
        .iter()
        .map(|m| ApiMessage {
            role: m.role.as_str(),
            content: m.content.as_str(),
        })
        .collect();

    let body = ApiRequest {
        model: &model,
        max_tokens: 16000,
        messages: api_messages,
        stream: true,
        system: None,
        output_config: None,
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let err = format!("Anthropic API error ({}): {}", status, text);
        let _ = app.emit("chat-error", serde_json::json!({ "session_id": session_id, "message": err }));
        return Err(err);
    }

    let assistant_id = format!("msg_{}", Uuid::new_v4().simple());
    let _ = app.emit(
        "chat-start",
        serde_json::json!({ "session_id": session_id, "message_id": assistant_id }),
    );

    let mut accumulated = String::new();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let err = format!("stream error: {}", e);
                let _ = app.emit(
                    "chat-error",
                    serde_json::json!({ "session_id": session_id, "message": err }),
                );
                return Err(err);
            }
        };
        let s = String::from_utf8_lossy(&bytes);
        buffer.push_str(&s);

        // Process complete SSE events (separated by blank lines).
        while let Some(idx) = buffer.find("\n\n") {
            let event_block: String = buffer.drain(..idx + 2).collect();
            for line in event_block.lines() {
                let line = line.trim();
                if let Some(payload) = line.strip_prefix("data:") {
                    let payload = payload.trim();
                    if payload.is_empty() || payload == "[DONE]" {
                        continue;
                    }
                    let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
                        continue;
                    };
                    let event_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if event_type == "content_block_delta" {
                        if let Some(text) = json
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            accumulated.push_str(text);
                            let _ = app.emit(
                                "chat-delta",
                                serde_json::json!({
                                    "session_id": session_id,
                                    "message_id": assistant_id,
                                    "text": text,
                                }),
                            );
                        }
                    } else if event_type == "message_stop" {
                        // handled after loop
                    } else if event_type == "error" {
                        let err = json
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown error")
                            .to_string();
                        let _ = app.emit(
                            "chat-error",
                            serde_json::json!({ "session_id": session_id, "message": err }),
                        );
                        return Err(err);
                    }
                }
            }
        }
    }

    // Persist assistant message.
    let mut session = read_session(&app, &session_id)?;
    session.messages.push(Message {
        id: assistant_id.clone(),
        role: "assistant".to_string(),
        content: accumulated.clone(),
        timestamp: Utc::now().to_rfc3339(),
    });
    session.updated_at = Utc::now().to_rfc3339();
    write_session(&app, &session)?;

    let _ = app.emit(
        "chat-done",
        serde_json::json!({
            "session_id": session_id,
            "message_id": assistant_id,
            "text": accumulated,
        }),
    );
    let _ = app.emit("session-updated", &session_id);
    Ok(assistant_id)
}

#[derive(Debug, Deserialize)]
pub struct AskMessage {
    pub role: String,
    pub content: String,
}

const ASK_STRUCTURED_SYSTEM: &str = "You return responses as JSON conforming to the provided schema. The output is a `segments` array; each segment has a `kind` and a `text` field.\n\n\
Use these kinds:\n\
- `name` — a proper noun: a specific person, place, organization, product, etc.\n\
- `concept` — a key technical term or idea worth investigating further.\n\
- `book` — the title of a book, article, paper, essay, film, album, or similar named work.\n\
- `definition` — a short explanatory phrase that defines or describes the term that immediately precedes it.\n\
- `text` — connective prose between highlights.\n\n\
RULES:\n\
1. When a `definition` segment appears, the IMMEDIATELY PRECEDING segment of any kind (skipping over whitespace-only `text` segments like `\" — \"` or `\": \"`) must be the `name`/`concept`/`book` it defines. Definitions never stand alone.\n\
2. Aim for 4–12 highlight segments (`name`/`concept`/`book`, with optional paired `definition`s) interleaved with `text` segments.\n\
3. Do not split single words across segments. Keep highlight segments compact (2–15 words).\n\
4. Concatenating every segment's `text` in order should read as natural, well-punctuated prose — include leading/trailing spaces and punctuation as needed in each segment's text.";

fn ask_response_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["text", "concept", "definition", "name", "book"]
                        },
                        "text": { "type": "string" }
                    },
                    "required": ["kind", "text"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["segments"],
        "additionalProperties": false
    })
}

#[tauri::command]
async fn ask_claude_stream(
    app: AppHandle,
    request_id: String,
    messages: Vec<AskMessage>,
    model: Option<String>,
) -> Result<(), String> {
    let settings = read_settings(&app);
    let api_key = settings
        .anthropic_api_key
        .ok_or_else(|| "No API key set. Open settings and paste your Anthropic key.".to_string())?;

    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let api_messages: Vec<ApiMessage> = messages
        .iter()
        .map(|m| ApiMessage {
            role: m.role.as_str(),
            content: m.content.as_str(),
        })
        .collect();

    let body = ApiRequest {
        model: &model,
        max_tokens: 1024,
        messages: api_messages,
        stream: true,
        system: Some(ASK_STRUCTURED_SYSTEM),
        output_config: Some(serde_json::json!({
            "format": {
                "type": "json_schema",
                "schema": ask_response_schema(),
            }
        })),
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let err = format!("Anthropic API error ({}): {}", status, text);
        let _ = app.emit(
            "ask-error",
            serde_json::json!({ "request_id": request_id, "message": err }),
        );
        return Err(err);
    }

    let _ = app.emit(
        "ask-start",
        serde_json::json!({ "request_id": request_id }),
    );

    let mut accumulated = String::new();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let err = format!("stream error: {}", e);
                let _ = app.emit(
                    "ask-error",
                    serde_json::json!({ "request_id": request_id, "message": err }),
                );
                return Err(err);
            }
        };
        let s = String::from_utf8_lossy(&bytes);
        buffer.push_str(&s);

        while let Some(idx) = buffer.find("\n\n") {
            let event_block: String = buffer.drain(..idx + 2).collect();
            for line in event_block.lines() {
                let line = line.trim();
                if let Some(payload) = line.strip_prefix("data:") {
                    let payload = payload.trim();
                    if payload.is_empty() || payload == "[DONE]" {
                        continue;
                    }
                    let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
                        continue;
                    };
                    let event_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if event_type == "content_block_delta" {
                        if let Some(text) = json
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            accumulated.push_str(text);
                            let _ = app.emit(
                                "ask-delta",
                                serde_json::json!({
                                    "request_id": request_id,
                                    "text": text,
                                }),
                            );
                        }
                    } else if event_type == "error" {
                        let err = json
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown error")
                            .to_string();
                        let _ = app.emit(
                            "ask-error",
                            serde_json::json!({ "request_id": request_id, "message": err }),
                        );
                        return Err(err);
                    }
                }
            }
        }
    }

    // Parse the accumulated JSON into segments. If parsing fails (model
    // didn't conform), fall back to emitting just the raw text so the
    // frontend can still surface something to the user.
    let parsed: Option<Vec<serde_json::Value>> =
        serde_json::from_str::<serde_json::Value>(&accumulated)
            .ok()
            .and_then(|v| v.get("segments").cloned())
            .and_then(|s| s.as_array().cloned());

    let plain_text = parsed
        .as_ref()
        .map(|segs| {
            segs.iter()
                .filter_map(|seg| seg.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_else(|| accumulated.clone());

    // The Anthropic stream can complete cleanly with no `content_block_delta`
    // events at all (e.g. the model went straight to a stop with no output, a
    // schema-only response that parsed to zero segments, etc.). Without this
    // guard the frontend would display an empty chat bubble and the user
    // would have no idea what happened.
    if plain_text.trim().is_empty() {
        let err = "Claude returned no text in its response. Try asking again.".to_string();
        let _ = app.emit(
            "ask-error",
            serde_json::json!({ "request_id": request_id, "message": err }),
        );
        return Err(err);
    }

    let _ = app.emit(
        "ask-done",
        serde_json::json!({
            "request_id": request_id,
            "text": plain_text,
            "segments": parsed,
            "raw": accumulated,
        }),
    );
    Ok(())
}

// --- Setup ---

#[cfg(desktop)]
fn build_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let initial_w = 1400.0_f64;
    let initial_h = 900.0_f64;

    // Use a bare Window + child Webview so we can later parent a second
    // (claude.ai) child webview under the same window for the sidebar's Chat
    // tab. WebviewWindowBuilder produces a single-webview window that doesn't
    // allow siblings, so we build the canvas as an explicit child instead.
    let window = tauri::window::WindowBuilder::new(app, WINDOW_LABEL)
        .title("Steiner")
        .inner_size(initial_w, initial_h)
        .min_inner_size(700.0, 500.0)
        .resizable(true)
        .build()?;

    let canvas = WebviewBuilder::new(CANVAS_LABEL, WebviewUrl::App("index.html".into()))
        .disable_drag_drop_handler();

    window.add_child(
        canvas,
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(initial_w, initial_h),
    )?;

    // Keep the canvas webview filling the window on resize. The chat webview
    // (when present) is repositioned by the frontend via show_chat_webview,
    // so it doesn't need to be repinned on resize from here.
    let app_for_resize = app.handle().clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            if let (Some(win), Some(canvas)) = (
                app_for_resize.get_window(WINDOW_LABEL),
                app_for_resize.get_webview(CANVAS_LABEL),
            ) {
                if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
                    let lw = size.width as f64 / scale;
                    let lh = size.height as f64 / scale;
                    let _ = canvas.set_position(LogicalPosition::new(0.0, 0.0));
                    let _ = canvas.set_size(LogicalSize::new(lw.max(1.0), lh.max(1.0)));
                }
                // Tell the frontend to reapply chat webview bounds (it knows
                // its own sidebar geometry).
                let _ = app_for_resize.emit("window-resized", ());
            }
        }
    });

    Ok(())
}

#[cfg(not(desktop))]
fn build_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    tauri::WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

/// Install a desktop menu where Undo/Redo are *custom* menu items (not the
/// `PredefinedMenuItem::undo/redo` ones) so their accelerators reach our
/// frontend via `menu:undo` / `menu:redo` events. The predefined items
/// dispatch system "undo:" / "redo:" to the focused responder (the
/// WKWebView's text-input undo manager), which has nothing to do with the
/// canvas state.
#[cfg(desktop)]
fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let pkg = &app.package_info().name;

    // App submenu (macOS only convention; harmless to include the same
    // structure on other desktops — Tauri ignores the app-name submenu off
    // macOS).
    let about = PredefinedMenuItem::about(
        app,
        Some(&format!("About {}", pkg)),
        Some(AboutMetadata::default()),
    )?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let app_submenu = Submenu::with_items(
        app,
        pkg,
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &services,
            &PredefinedMenuItem::separator(app)?,
            &hide,
            &hide_others,
            &show_all,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // Edit submenu: only custom Undo/Redo. The standard Cut/Copy/Paste
    // predefined items have the same problem as the predefined undo/redo
    // ones — their Cmd+X / C / V accelerators route through the system as
    // `cut:` / `copy:` / `paste:` selectors and never reach our JS
    // keydown handler. Leaving them out means the shortcut falls through
    // to WKWebView's native key handling, which is exactly what we want:
    // JS keydown handles canvas copy/paste, native handling covers
    // input/textarea focus. Select All is omitted for the same reason —
    // when canvas Select All is wanted it can be wired later as a custom
    // menu item that emits an event.
    let undo = MenuItem::with_id(app, "menu:undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(
        app,
        "menu:redo",
        "Redo",
        true,
        Some("Shift+CmdOrCtrl+Z"),
    )?;
    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[&undo, &redo],
    )?;

    // Window submenu — minimize / fullscreen / close are useful on macOS.
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;
    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&minimize, &fullscreen, &PredefinedMenuItem::separator(app)?, &close_window],
    )?;

    let menu = Menu::with_items(app, &[&app_submenu, &edit_submenu, &window_submenu])?;
    app.set_menu(menu)?;

    let app_for_menu = app.clone();
    app.on_menu_event(move |_app, event| {
        match event.id().as_ref() {
            "menu:undo" => {
                let _ = app_for_menu.emit_to(CANVAS_LABEL, "menu:undo", ());
            }
            "menu:redo" => {
                let _ = app_for_menu.emit_to(CANVAS_LABEL, "menu:redo", ());
            }
            _ => {}
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Single-instance: a second launch (e.g. macOS opening the steiner://
    // OAuth callback URL) forwards its argv to the running instance instead
    // of starting a fresh process. The deep-link plugin's macOS Apple Event
    // handler covers most cases, but in dev mode LaunchServices can route to
    // a stale binary; this is the belt to that suspenders.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!("[steiner] single-instance second-launch argv: {:?}", argv);
            let _ = app.emit("steiner://second-instance", argv);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            current_stream: Mutex::new(None),
            #[cfg(desktop)]
            created_browsers: Mutex::new(std::collections::HashSet::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_api_key,
            set_ask_word_limit,
            set_ask_model,
            set_ask_prompt_prefix,
            set_ask_prompt_suffix,
            is_desktop,
            show_browser_webview,
            hide_browser_webview,
            list_sessions,
            create_session,
            get_session,
            update_session_title,
            update_session_model,
            set_session_archived,
            save_session_canvas,
            delete_session,
            export_session_markdown,
            write_text_file,
            write_binary_file,
            send_message,
            ask_claude_stream,
            dropbox::dropbox_exchange_code,
            dropbox::dropbox_refresh_token,
            dropbox::dropbox_disconnect,
            dropbox::dropbox_status,
            dropbox::dropbox_sync_now,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Claim the steiner:// scheme for the running binary at startup.
            // In dev mode LaunchServices may have a stale handler registered
            // from a previous build; register_all forces it to point at the
            // current binary so the OAuth callback lands here. Mirrored on
            // mobile where the entitlement registration happens via the bundle.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("[steiner] deep-link register_all failed: {:?}", e);
                }
                let app_for_deep = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().iter().map(|u| u.to_string()).collect();
                    log::info!("[steiner] deep-link on_open_url: {:?}", urls);
                    // Emit a fallback event the frontend listens for in case
                    // the JS plugin's onOpenUrl misses the delivery in dev.
                    let _ = app_for_deep.emit("steiner://deep-link", &urls);
                });
            }

            // Build a custom application menu so Edit > Undo / Redo emit
            // events to our frontend instead of dispatching the system
            // "undo:" / "redo:" responder messages — those go to the
            // WKWebView's text undo manager, not to our canvas state.
            #[cfg(desktop)]
            install_app_menu(app.handle())?;

            build_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
