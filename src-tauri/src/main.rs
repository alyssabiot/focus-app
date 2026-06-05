// src-tauri/src/main.rs
// Backend Rust pour Focus App
// Gère le stockage fichier natif dans ~/.focus-app/

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

/// Retourne le répertoire de données de l'app : ~/.focus-app/
fn data_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Impossible de trouver le home directory");
    home.join(".focus-app")
}

/// Retourne le chemin d'un fichier de données
fn data_file(key: &str) -> PathBuf {
    // Sanitize : on n'autorise que les caractères alphanumériques et _-
    let safe_key: String = key.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    data_dir().join(format!("{}.json", safe_key))
}

/// Crée le répertoire de données s'il n'existe pas
fn ensure_data_dir() -> Result<(), String> {
    let dir = data_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Charge une valeur depuis le disque
#[tauri::command]
fn load_data(key: String) -> Result<Option<String>, String> {
    ensure_data_dir()?;
    let path = data_file(&key);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

/// Sauvegarde une valeur sur le disque
#[tauri::command]
fn save_data(key: String, value: String) -> Result<(), String> {
    ensure_data_dir()?;
    let path = data_file(&key);
    fs::write(&path, value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Supprime une valeur
#[tauri::command]
fn delete_data(key: String) -> Result<(), String> {
    let path = data_file(&key);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Liste toutes les clés disponibles
#[tauri::command]
fn list_keys() -> Result<Vec<String>, String> {
    ensure_data_dir()?;
    let dir = data_dir();
    let mut keys = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                keys.push(stem.to_string());
            }
        }
    }
    Ok(keys)
}

/// Encodage pourcent minimal pour les paramètres d'URL OAuth.
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Décodage pourcent d'une valeur d'URL (`%2F` → `/`, `+` → espace).
fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extrait un paramètre d'une query string (`code=...&state=...`).
fn query_param(qs: &str, key: &str) -> Option<String> {
    qs.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        if k != key {
            return None;
        }
        Some(pct_decode(it.next().unwrap_or("")))
    })
}

/// Lance le flux OAuth Google : ouvre un serveur loopback, ouvre le navigateur
/// sur l'écran de consentement, capte la redirection et renvoie le code.
#[tauri::command]
fn google_oauth(
    client_id: String,
    scope: String,
    code_challenge: String,
    state: String,
    login_hint: Option<String>,
) -> Result<serde_json::Value, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}", port);

    let mut auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        pct(&client_id), pct(&redirect_uri), pct(&scope), pct(&code_challenge), pct(&state)
    );
    if let Some(h) = login_hint {
        auth_url.push_str(&format!("&login_hint={}", pct(&h)));
    }

    // macOS : ouvre le navigateur par défaut.
    std::process::Command::new("open")
        .arg(&auth_url)
        .spawn()
        .map_err(|e| format!("Impossible d'ouvrir le navigateur : {}", e))?;

    // Attend la redirection (timeout ~5 min) sans bloquer indéfiniment.
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(300);

    loop {
        if std::time::Instant::now() > deadline {
            return Err("Délai de connexion dépassé.".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(conn) => conn,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).ok();
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();

        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let request_line = req.lines().next().unwrap_or("");
        // Ignore les requêtes parasites (favicon, etc.).
        let path = request_line.split_whitespace().nth(1).unwrap_or("");
        if !path.starts_with("/?") && !path.starts_with("/callback") && path != "/" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let qs = path.splitn(2, '?').nth(1).unwrap_or("");
        let code = query_param(qs, "code");
        let st = query_param(qs, "state");
        let err = query_param(qs, "error");

        let body = "<!doctype html><html lang=fr><meta charset=utf-8><body style='font-family:-apple-system,sans-serif;background:#f4eee1;color:#2b2620;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><h2 style='font-weight:500'>Connexion réussie</h2><p style='color:#6c6356'>Vous pouvez fermer cet onglet et revenir à Focus.</p></div></body></html>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(resp.as_bytes());

        if let Some(e) = err {
            return Err(format!("Consentement refusé : {}", e));
        }
        if st.as_deref() != Some(state.as_str()) {
            return Err("Échec de sécurité (state invalide).".into());
        }
        let code = code.ok_or("Aucun code d'autorisation reçu.")?;
        return Ok(serde_json::json!({ "code": code, "redirect_uri": redirect_uri }));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            delete_data,
            list_keys,
            google_oauth,
        ])
        .setup(|app| {
            // En développement, ouvre les DevTools
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Erreur lors du lancement de Focus App");
}
