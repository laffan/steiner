// Dropbox OAuth (PKCE) + manual sync of session JSON files.
//
// Scope expectations (configure on the Dropbox app):
//   - Type:           Scoped App, "App folder" access
//   - Permissions:    files.content.read, files.content.write, account_info.read
//   - Redirect URI:   steiner://auth/callback
//
// The frontend owns PKCE generation and the auth-URL build (it knows the
// app key); the backend owns token exchange/refresh and the actual file
// sync, so tokens never round-trip through the renderer beyond a "set"
// presence indicator.

use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    read_session, read_settings, sessions_dir, session_path, write_settings, Session,
};

const TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";
const ACCOUNT_URL: &str = "https://api.dropboxapi.com/2/users/get_current_account";
const LIST_FOLDER_URL: &str = "https://api.dropboxapi.com/2/files/list_folder";
const LIST_FOLDER_CONTINUE_URL: &str = "https://api.dropboxapi.com/2/files/list_folder/continue";
const UPLOAD_URL: &str = "https://content.dropboxapi.com/2/files/upload";
const DOWNLOAD_URL: &str = "https://content.dropboxapi.com/2/files/download";

const REMOTE_SESSIONS_DIR: &str = "/sessions";

#[derive(Debug, Serialize, Deserialize)]
pub struct DropboxStatus {
    pub linked: bool,
    pub account_email: Option<String>,
    pub last_sync: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub uploaded: u32,
    pub downloaded: u32,
    pub skipped: u32,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountResponse {
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListFolderResponse {
    entries: Vec<DropboxEntry>,
    cursor: String,
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = ".tag", rename_all = "snake_case")]
enum DropboxEntry {
    File {
        name: String,
        path_lower: String,
        #[serde(default)]
        client_modified: Option<String>,
        #[serde(default)]
        server_modified: Option<String>,
    },
    #[serde(other)]
    Other,
}

// --- Tauri commands ---

#[tauri::command]
pub async fn dropbox_exchange_code(
    app: AppHandle,
    code: String,
    code_verifier: String,
    app_key: String,
    redirect_uri: String,
) -> Result<DropboxStatus, String> {
    let client = reqwest::Client::new();
    let params = [
        ("code", code.as_str()),
        ("grant_type", "authorization_code"),
        ("client_id", app_key.as_str()),
        ("code_verifier", code_verifier.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    let resp = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("token request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox token exchange ({}): {}", status, body));
    }
    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("parse token response: {}", e))?;

    let email = fetch_account_email(&client, &tokens.access_token).await.ok();

    let mut s = read_settings(&app);
    s.dropbox_access_token = Some(tokens.access_token);
    if let Some(rt) = tokens.refresh_token.clone() {
        s.dropbox_refresh_token = Some(rt);
    }
    s.dropbox_account_email = email.clone();
    write_settings(&app, &s)?;

    Ok(DropboxStatus {
        linked: true,
        account_email: email,
        last_sync: s.dropbox_last_sync,
    })
}

#[tauri::command]
pub async fn dropbox_refresh_token(
    app: AppHandle,
    app_key: String,
) -> Result<String, String> {
    let s = read_settings(&app);
    let refresh = s
        .dropbox_refresh_token
        .clone()
        .ok_or_else(|| "Not linked to Dropbox".to_string())?;
    let new_access = refresh_access_token(&refresh, &app_key).await?;
    let mut s = read_settings(&app);
    s.dropbox_access_token = Some(new_access.clone());
    write_settings(&app, &s)?;
    Ok(new_access)
}

#[tauri::command]
pub async fn dropbox_disconnect(app: AppHandle) -> Result<(), String> {
    let mut s = read_settings(&app);
    s.dropbox_access_token = None;
    s.dropbox_refresh_token = None;
    s.dropbox_account_email = None;
    s.dropbox_last_sync = None;
    write_settings(&app, &s)
}

#[tauri::command]
pub fn dropbox_status(app: AppHandle) -> DropboxStatus {
    let s = read_settings(&app);
    DropboxStatus {
        linked: s.dropbox_access_token.is_some(),
        account_email: s.dropbox_account_email,
        last_sync: s.dropbox_last_sync,
    }
}

#[tauri::command]
pub async fn dropbox_sync_now(
    app: AppHandle,
    app_key: String,
) -> Result<SyncResult, String> {
    let s = read_settings(&app);
    let access = s
        .dropbox_access_token
        .clone()
        .ok_or_else(|| "Not linked to Dropbox".to_string())?;
    let refresh = s.dropbox_refresh_token.clone();
    let client = reqwest::Client::new();

    // Try the sync; on 401, refresh once and retry.
    let result = run_sync(&app, &client, &access).await;
    let result = match result {
        Ok(r) => r,
        Err(e) if e.contains("401") && refresh.is_some() => {
            let new_access = refresh_access_token(refresh.as_deref().unwrap(), &app_key).await?;
            let mut s = read_settings(&app);
            s.dropbox_access_token = Some(new_access.clone());
            write_settings(&app, &s)?;
            run_sync(&app, &client, &new_access).await?
        }
        Err(e) => return Err(e),
    };

    let mut s = read_settings(&app);
    s.dropbox_last_sync = Some(Utc::now().to_rfc3339());
    write_settings(&app, &s)?;

    Ok(result)
}

// --- Internals ---

async fn fetch_account_email(client: &reqwest::Client, access: &str) -> Result<String, String> {
    let resp = client
        .post(ACCOUNT_URL)
        .bearer_auth(access)
        .header("content-type", "application/json")
        // get_current_account takes no body, but Dropbox still wants a JSON
        // content-type with `null`.
        .body("null")
        .send()
        .await
        .map_err(|e| format!("account: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("account fetch failed: {}", resp.status()));
    }
    let acct: AccountResponse = resp
        .json()
        .await
        .map_err(|e| format!("account parse: {}", e))?;
    acct.email.ok_or_else(|| "no email on account".to_string())
}

async fn refresh_access_token(refresh: &str, app_key: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", app_key),
    ];
    let resp = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("refresh failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("refresh ({}): {}", status, body));
    }
    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("refresh parse: {}", e))?;
    Ok(tokens.access_token)
}

async fn run_sync(
    app: &AppHandle,
    client: &reqwest::Client,
    access: &str,
) -> Result<SyncResult, String> {
    let local_dir = sessions_dir(app)?;
    let local_files = fs::read_dir(&local_dir)
        .map_err(|e| format!("read sessions dir: {}", e))?
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "json")
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    // Build local map: file stem -> updated_at (parsed from session JSON).
    let mut local_map: std::collections::HashMap<String, (String, PathBuf)> =
        std::collections::HashMap::new();
    for entry in &local_files {
        let path = entry.path();
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let updated = read_session(app, &stem)
            .ok()
            .map(|s: Session| s.updated_at)
            .unwrap_or_default();
        local_map.insert(stem, (updated, path));
    }

    // List remote.
    let remote_entries = list_remote_sessions(client, access).await?;
    let mut remote_map: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new(); // id -> (server_modified, path_lower)
    for entry in remote_entries {
        if let DropboxEntry::File {
            name,
            path_lower,
            client_modified,
            server_modified,
        } = entry
        {
            if !name.ends_with(".json") {
                continue;
            }
            let id = name.trim_end_matches(".json").to_string();
            let modified = client_modified
                .or(server_modified)
                .unwrap_or_default();
            remote_map.insert(id, (modified, path_lower));
        }
    }

    let mut uploaded = 0u32;
    let mut downloaded = 0u32;
    let mut skipped = 0u32;

    // Walk the union of local + remote ids.
    let mut all_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for k in local_map.keys() {
        all_ids.insert(k.clone());
    }
    for k in remote_map.keys() {
        all_ids.insert(k.clone());
    }

    for id in &all_ids {
        let local = local_map.get(id);
        let remote = remote_map.get(id);
        match (local, remote) {
            (Some((_, path)), None) => {
                upload_session(client, access, id, path).await?;
                uploaded += 1;
            }
            (None, Some((_, remote_path))) => {
                let body = download_remote(client, access, remote_path).await?;
                let local_path = session_path(app, id)?;
                fs::write(&local_path, body).map_err(|e| format!("write local: {}", e))?;
                downloaded += 1;
            }
            (Some((local_updated, path)), Some((remote_modified, remote_path))) => {
                // Compare timestamps; whichever is newer wins. Both are
                // ISO-8601-ish strings sortable lexicographically.
                if local_updated.as_str() > remote_modified.as_str() {
                    upload_session(client, access, id, path).await?;
                    uploaded += 1;
                } else if local_updated.as_str() < remote_modified.as_str() {
                    let body = download_remote(client, access, remote_path).await?;
                    fs::write(path, body).map_err(|e| format!("write local: {}", e))?;
                    downloaded += 1;
                } else {
                    skipped += 1;
                }
            }
            (None, None) => {}
        }
    }

    Ok(SyncResult { uploaded, downloaded, skipped })
}

async fn list_remote_sessions(
    client: &reqwest::Client,
    access: &str,
) -> Result<Vec<DropboxEntry>, String> {
    let body = serde_json::json!({
        "path": REMOTE_SESSIONS_DIR,
        "recursive": false,
        "include_deleted": false,
        "include_has_explicit_shared_members": false,
    });
    let mut resp = client
        .post(LIST_FOLDER_URL)
        .bearer_auth(access)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("list_folder: {}", e))?;
    if resp.status().as_u16() == 409 {
        // Folder doesn't exist yet — return empty list rather than erroring.
        return Ok(Vec::new());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("list_folder ({}): {}", status, txt));
    }
    let mut all = Vec::new();
    loop {
        let page: ListFolderResponse = resp
            .json()
            .await
            .map_err(|e| format!("list parse: {}", e))?;
        all.extend(page.entries);
        if !page.has_more {
            break;
        }
        resp = client
            .post(LIST_FOLDER_CONTINUE_URL)
            .bearer_auth(access)
            .header("content-type", "application/json")
            .body(serde_json::json!({ "cursor": page.cursor }).to_string())
            .send()
            .await
            .map_err(|e| format!("list_continue: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!("list_continue ({}): {}", status, txt));
        }
    }
    Ok(all)
}

async fn upload_session(
    client: &reqwest::Client,
    access: &str,
    id: &str,
    local_path: &PathBuf,
) -> Result<(), String> {
    let bytes = fs::read(local_path).map_err(|e| format!("read local: {}", e))?;
    let arg = serde_json::json!({
        "path": format!("{}/{}.json", REMOTE_SESSIONS_DIR, id),
        "mode": "overwrite",
        "autorename": false,
        "mute": true,
        "strict_conflict": false,
    });
    let resp = client
        .post(UPLOAD_URL)
        .bearer_auth(access)
        .header("content-type", "application/octet-stream")
        .header("Dropbox-API-Arg", arg.to_string())
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("upload: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("upload ({}): {}", status, txt));
    }
    Ok(())
}

async fn download_remote(
    client: &reqwest::Client,
    access: &str,
    path_lower: &str,
) -> Result<Vec<u8>, String> {
    let arg = serde_json::json!({ "path": path_lower });
    let resp = client
        .post(DOWNLOAD_URL)
        .bearer_auth(access)
        .header("Dropbox-API-Arg", arg.to_string())
        .send()
        .await
        .map_err(|e| format!("download: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("download ({}): {}", status, txt));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("download body: {}", e))?;
    Ok(bytes.to_vec())
}
