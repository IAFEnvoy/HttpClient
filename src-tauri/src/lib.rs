use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::TokioAsyncResolver;
use whois_service::WhoisClient;

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
        .invoke_handler(tauri::generate_handler![fetch, dns_lookup, whois_lookup])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ═════════════════════════════════════════════════════════════════
//  DNS LOOKUP  —  trust-dns-resolver
// ═════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize)]
struct DnsRecord {
    r#type: String,
    name: String,
    value: String,
    ttl: u32,
}

#[derive(Debug, Serialize)]
struct DnsResult {
    domain: String,
    records: Vec<DnsRecord>,
    error: Option<String>,
}

#[tauri::command]
async fn dns_lookup(domain: String) -> Result<DnsResult, String> {
    let resolver = TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default());

    let lookup_types: &[trust_dns_resolver::proto::rr::RecordType] = &[
        trust_dns_resolver::proto::rr::RecordType::A,
        trust_dns_resolver::proto::rr::RecordType::AAAA,
        trust_dns_resolver::proto::rr::RecordType::MX,
        trust_dns_resolver::proto::rr::RecordType::NS,
        trust_dns_resolver::proto::rr::RecordType::TXT,
        trust_dns_resolver::proto::rr::RecordType::CNAME,
        trust_dns_resolver::proto::rr::RecordType::SOA,
    ];

    let mut records = Vec::new();
    let mut error: Option<String> = None;

    for rt in lookup_types {
        let rt_name = format!("{:?}", rt);
        match resolver.lookup(domain.clone(), *rt).await {
            Ok(lookup) => {
                for r in lookup.record_iter() {
                    records.push(DnsRecord {
                        r#type: rt_name.clone(),
                        name: r.name().to_string(),
                        value: format_record_data(r.data()),
                        ttl: r.ttl(),
                    });
                }
            }
            Err(e) => {
                // Record type not found is normal, only log other errors
                let msg = e.to_string();
                if !msg.contains("no record found") && !msg.contains("NXDOMAIN") {
                    if error.is_none() {
                        error = Some(msg);
                    }
                }
            }
        }
    }

    Ok(DnsResult {
        domain,
        records,
        error,
    })
}

fn format_record_data(data: Option<&trust_dns_resolver::proto::rr::RData>) -> String {
    match data {
        Some(d) => {
            let s = format!("{}", d);
            // Strip trailing dot from absolute names
            s.trim_end_matches('.').to_string()
        }
        None => "(unknown)".to_string(),
    }
}

// ═════════════════════════════════════════════════════════════════
//  WHOIS LOOKUP  —  whois-service library
// ═════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize)]
struct WhoisResult {
    domain: String,
    summary: String,
    raw_text: String,
    error: Option<String>,
}

#[tauri::command]
async fn whois_lookup(domain: String) -> Result<WhoisResult, String> {
    let client = WhoisClient::new()
        .await
        .map_err(|e| format!("初始化 WHOIS 客户端失败: {}", e))?;

    match client.lookup(&domain).await {
        Ok(result) => {
            let summary =
                build_whois_summary(&result.whois_server, &result.raw_data, &result.parsed_data);
            Ok(WhoisResult {
                domain,
                summary,
                raw_text: result.raw_data,
                error: None,
            })
        }
        Err(e) => Ok(WhoisResult {
            domain,
            summary: String::new(),
            raw_text: String::new(),
            error: Some(format!("WHOIS 查询失败: {}", e)),
        }),
    }
}

/// Build a human-readable summary from parsed WHOIS data
fn build_whois_summary(
    server: &str,
    raw_data: &str,
    parsed: &Option<whois_service::ParsedWhoisData>,
) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push(format!("查询服务器: {}", server));

    // Try to extract IANA ID from raw text
    if let Some(iana_id) = extract_whois_field(raw_data, "IANA ID") {
        lines.push(format!("IANA ID: {}", iana_id));
    }

    // Try to extract Abuse contact from raw text
    if let Some(abuse_email) = extract_whois_field(raw_data, "Abuse Contact Email") {
        lines.push(format!("Abuse 举报邮箱: {}", abuse_email));
    }
    if let Some(abuse_phone) = extract_whois_field(raw_data, "Abuse Contact Phone") {
        lines.push(format!("Abuse 举报电话: {}", abuse_phone));
    }

    lines.push(String::new());

    if let Some(data) = parsed {
        // ── Basic Info ──
        lines.push("── 基本信息 ──".to_string());

        if let Some(ref r) = data.registrar {
            lines.push(format!("注册商: {}", r));
        }
        if let Some(ref c) = data.creation_date {
            lines.push(format!("创建时间: {}", c));
        }
        if let Some(ref u) = data.updated_date {
            lines.push(format!("更新时间: {}", u));
        }
        if let Some(ref e) = data.expiration_date {
            lines.push(format!("过期时间: {}", e));
        }

        // Age fields
        if let Some(ca) = data.created_ago {
            lines.push(format!("已创建 (天): {} 天前", ca));
        }
        if let Some(ua) = data.updated_ago {
            lines.push(format!("已更新 (天): {} 天前", ua));
        }
        if let Some(ei) = data.expires_in {
            if ei < 0 {
                lines.push(format!("已过期: {} 天", ei.abs()));
            } else {
                lines.push(format!("距离过期: {} 天", ei));
            }
        }

        // Domain status
        if !data.status.is_empty() {
            lines.push(String::new());
            lines.push("域名状态:".to_string());
            for s in &data.status {
                lines.push(format!("  • {}", s));
            }
        }

        // Name servers
        if !data.name_servers.is_empty() {
            lines.push(String::new());
            lines.push("DNS 服务器:".to_string());
            for ns in &data.name_servers {
                lines.push(format!("  • {}", ns));
            }
        }

        // ── Contacts ──
        let has_contacts = data.registrant_name.is_some()
            || data.registrant_email.is_some()
            || data.admin_email.is_some()
            || data.tech_email.is_some();
        if has_contacts {
            lines.push(String::new());
            lines.push("── 联系信息 ──".to_string());
            if let Some(ref name) = data.registrant_name {
                lines.push(format!("注册人: {}", name));
            }
            if let Some(ref email) = data.registrant_email {
                lines.push(format!("注册人邮箱: {}", email));
            }
            if let Some(ref email) = data.admin_email {
                lines.push(format!("管理员邮箱: {}", email));
            }
            if let Some(ref email) = data.tech_email {
                lines.push(format!("技术邮箱: {}", email));
            }
        }
    }

    lines.push(String::new());
    lines.push("══════════════════════════════════════".to_string());
    lines.push(String::new());

    lines.join("\n")
}

/// Extract a field value from WHOIS raw text by label (e.g. "Registrar IANA ID: 1234")
fn extract_whois_field(text: &str, label: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let label_lower = label.to_lowercase();
    for line in lower.lines() {
        if line.contains(&label_lower) {
            let val = line.split(':').nth(1).unwrap_or("").trim();
            if !val.is_empty() {
                // Return the original-case version from the raw text
                // Find the matching line in original case
                for orig in text.lines() {
                    if orig.to_lowercase().contains(&label_lower) {
                        let orig_val = orig.split(':').nth(1).unwrap_or("").trim();
                        if !orig_val.is_empty() {
                            return Some(orig_val.to_string());
                        }
                    }
                }
                return Some(val.to_string());
            }
        }
    }
    None
}
