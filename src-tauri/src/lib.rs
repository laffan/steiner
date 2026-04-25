use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const CANVAS_LABEL: &str = "canvas";
const CLAUDE_LABEL: &str = "claude";
const WINDOW_LABEL: &str = "main";

const CLAUDE_INIT_SCRIPT: &str = include_str!("../../src/claude-content-script.js");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub text: String,
    pub url: String,
    pub timestamp: String,
    pub context: String,
}

pub struct AppState {
    pub split_fraction: Mutex<f64>,
}

#[tauri::command]
fn pin_snippet(app: AppHandle, snippet: Snippet) -> Result<(), String> {
    log::info!(
        "pin_snippet received from claude webview: {} chars",
        snippet.text.len()
    );
    app.emit_to(CANVAS_LABEL, "snippet-pinned", &snippet)
        .map_err(|e| e.to_string())?;
    append_snippet(&app, &snippet)?;
    Ok(())
}

#[tauri::command]
fn send_to_claude(app: AppHandle, text: String, submit: bool) -> Result<bool, String> {
    let claude = app
        .get_webview(CLAUDE_LABEL)
        .ok_or_else(|| "claude webview not found".to_string())?;
    let payload = serde_json::json!({ "text": text, "submit": submit });
    let js = format!(
        "window.__steinerSendToClaude && window.__steinerSendToClaude({})",
        payload
    );
    claude.eval(&js).map_err(|e| e.to_string())?;
    let _ = claude.set_focus();
    Ok(true)
}

#[tauri::command]
fn set_split_fraction(app: AppHandle, fraction: f64) -> Result<(), String> {
    let f = fraction.clamp(0.15, 0.85);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut split) = state.split_fraction.lock() {
            *split = f;
        }
    }
    layout_webviews(&app, f)
}

#[tauri::command]
fn nudge_split(app: AppHandle, delta_pixels: f64) -> Result<(), String> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_w = size.width as f64 / scale;
    if logical_w <= 0.0 {
        return Ok(());
    }
    let current = current_fraction(&app);
    let new_fraction = ((current * logical_w) + delta_pixels) / logical_w;
    set_split_fraction(app, new_fraction)
}

#[tauri::command]
fn load_snippets(app: AppHandle) -> Result<Vec<Snippet>, String> {
    let path = snippets_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_canvas_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = canvas_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

#[tauri::command]
fn save_canvas_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = canvas_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(())
}

fn append_snippet(app: &AppHandle, snippet: &Snippet) -> Result<(), String> {
    let path = snippets_path(app)?;
    let mut snippets: Vec<Snippet> = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            vec![]
        } else {
            serde_json::from_str(&raw).unwrap_or_default()
        }
    } else {
        vec![]
    };
    snippets.push(snippet.clone());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&snippets).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn snippets_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("snippets.json"))
}

fn canvas_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("canvas.json"))
}

fn layout_webviews(app: &AppHandle, fraction: f64) -> Result<(), String> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let split = (logical_w * fraction).round();
    let right_w = (logical_w - split).max(1.0);

    if let Some(claude) = app.get_webview(CLAUDE_LABEL) {
        let _ = claude.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = claude.set_size(LogicalSize::new(split, logical_h));
    }
    if let Some(canvas) = app.get_webview(CANVAS_LABEL) {
        let _ = canvas.set_position(LogicalPosition::new(split, 0.0));
        let _ = canvas.set_size(LogicalSize::new(right_w, logical_h));
    }
    Ok(())
}

fn current_fraction(app: &AppHandle) -> f64 {
    app.try_state::<AppState>()
        .and_then(|s| s.split_fraction.lock().ok().map(|g| *g))
        .unwrap_or(0.5)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            split_fraction: Mutex::new(0.5),
        })
        .invoke_handler(tauri::generate_handler![
            pin_snippet,
            send_to_claude,
            set_split_fraction,
            nudge_split,
            load_snippets,
            load_canvas_state,
            save_canvas_state,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let initial_w = 1400.0_f64;
            let initial_h = 900.0_f64;

            let window = tauri::window::WindowBuilder::new(app, WINDOW_LABEL)
                .title("Steiner — AI Brainstorm")
                .inner_size(initial_w, initial_h)
                .min_inner_size(800.0, 500.0)
                .resizable(true)
                .build()?;

            let half = (initial_w / 2.0).round();

            let claude_webview = WebviewBuilder::new(
                CLAUDE_LABEL,
                WebviewUrl::External("https://claude.ai/".parse().unwrap()),
            )
            .initialization_script(CLAUDE_INIT_SCRIPT);

            let canvas_webview =
                WebviewBuilder::new(CANVAS_LABEL, WebviewUrl::App("index.html".into()))
                    .disable_drag_drop_handler();

            window.add_child(
                claude_webview,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(half, initial_h),
            )?;

            window.add_child(
                canvas_webview,
                LogicalPosition::new(half, 0.0),
                LogicalSize::new(initial_w - half, initial_h),
            )?;

            let app_for_resize = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
                ) {
                    let f = current_fraction(&app_for_resize);
                    let _ = layout_webviews(&app_for_resize, f);
                }
            });

            let app_for_shortcut = app.handle().clone();
            let shortcut = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::SHIFT),
                Code::KeyP,
            );
            app.global_shortcut()
                .on_shortcut(shortcut, move |_app, _sc, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(claude) = app_for_shortcut.get_webview(CLAUDE_LABEL) {
                            let _ = claude.eval(
                                "window.__steinerCapturePin && window.__steinerCapturePin()",
                            );
                        }
                    }
                })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
