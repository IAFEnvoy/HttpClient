use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[tauri::command]
async fn fetch(request: HttpRequest) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| format!("build client: {}", e))?;

    let mut req = match request.method.to_uppercase().as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        "PATCH" => client.patch(&request.url),
        "HEAD" => client.head(&request.url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, &request.url),
        m => return Err(format!("unsupported method: {}", m)),
    };

    for (k, v) in &request.headers {
        req = req.header(k, v);
    }
    if let Some(b) = &request.body {
        req = req.body(b.clone());
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "timeout".into()
        } else if e.is_connect() {
            format!("connect: {}", e)
        } else {
            format!("request: {}", e)
        }
    })?;

    let status = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(val) = v.to_str() {
            headers.insert(k.to_string(), val.to_string());
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {}", e))?
        .to_vec();

    Ok(HttpResponse {
        status,
        status_text,
        headers,
        body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
