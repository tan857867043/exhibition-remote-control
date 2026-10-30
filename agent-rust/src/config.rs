use serde::Deserialize;
use std::io::Read;
use std::path::PathBuf;

const EXE_CONFIG_GUID: &[u8] = &[0xB9, 0x96, 0x01, 0x58, 0x80, 0x54, 0x4A, 0x19, 0xB7, 0xF7, 0xE9, 0xBE, 0x44, 0x91, 0x4C, 0x18];

#[derive(Deserialize, Debug, Default)]
pub struct AgentConfig {
    pub server_url: Option<String>,
    pub device_name: Option<String>,
}

pub fn read_embedded_config() -> Option<AgentConfig> {
    let exe_path = std::env::current_exe().ok()?;
    let mut file = std::fs::File::open(&exe_path).ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    if data.len() < 16 + 4 + 2 { return None; }
    let search_start = if data.len() > 65536 { data.len() - 65536 } else { 0 };
    for i in (search_start..=data.len() - 16).rev() {
        if &data[i..i + 16] == EXE_CONFIG_GUID {
            if i < 4 { return None; }
            let len_start = i - 4;
            let config_len = ((data[len_start] as usize) << 24)
                | ((data[len_start + 1] as usize) << 16)
                | ((data[len_start + 2] as usize) << 8)
                | (data[len_start + 3] as usize);
            if config_len == 0 || config_len > 4096 { return None; }
            // 防 underflow：config_len 不能超过 len_start，否则切片索引会回绕/越界 panic
            if config_len > len_start { return None; }
            let config_start = len_start - config_len;
            let config_str = std::str::from_utf8(&data[config_start..len_start]).ok()?;
            return serde_json::from_str(config_str).ok();
        }
    }
    None
}

pub fn parse_server_args() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--server" && i + 1 < args.len() {
            return Some(args[i + 1].clone());
        }
        if let Some(url) = args[i].strip_prefix("--server=") {
            return Some(url.to_string());
        }
    }
    None
}

pub fn http_to_ws(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("ws://{}", rest);
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return format!("wss://{}", rest);
    }
    url.to_string()
}

/// 最近一次 UDP 发现得到的 Hub 地址缓存（用户级可写目录，普通用户 agent 可写）。
/// Hub 换 IP 后 agent 通过广播发现新 Hub，写入此文件，重启后依然生效。
fn discovery_cache_path() -> PathBuf {
    if let Ok(ad) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(ad).join("ExhibitionAgent").join("server_url.txt")
    } else {
        PathBuf::from("ExhibitionAgent").join("server_url.txt")
    }
}

pub fn read_discovered_url() -> Option<String> {
    let s = std::fs::read_to_string(discovery_cache_path()).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() {
        return None;
    }
    Some(http_to_ws(&s))
}

pub fn write_discovered_url(url: &str) -> bool {
    let p = discovery_cache_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, http_to_ws(url)).is_ok()
}

/// Agent 安装目录下的 config.json（由 install_service / --config-ui / --config-ui-write 写入）。
/// 之前 resolve_server_url() 从不读它，导致用户通过「配置服务器地址」改写的 Hub 地址不生效，
/// 远端 Agent 永远连不上（或退回 127.0.0.1）——这是「局域网其他电脑 Agent 连不上 Hub」的根因之一。
const INSTALLED_CONFIG_FILE: &str = "C:\\Program Files\\ExhibitionAgent\\config.json";

fn read_installed_config_url() -> Option<String> {
    let s = std::fs::read_to_string(INSTALLED_CONFIG_FILE).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let mut url = v.get("server_url").and_then(|u| u.as_str())?.trim().to_string();
    // 容错：配置 UI 的示例文本带 "/ws" 后缀，若用户照示例填写会导致 WebSocket 路径拼接错误
    // （例：ws://192.168.1.33:38921/ws + /agent/register → 错误路径），这里剥掉尾部 /ws。
    if let Some(stripped) = url.strip_suffix("/ws") {
        url = stripped.to_string();
    }
    if url.is_empty() {
        return None;
    }
    Some(http_to_ws(&url))
}

/// 清除 UDP 发现缓存。--config-ui 写入新地址后调用，确保用户显式配置优先于旧发现结果。
pub fn clear_discovered_url() {
    let _ = std::fs::remove_file(discovery_cache_path());
}

pub fn resolve_server_url() -> String {
    if let Some(url) = parse_server_args() {
        return http_to_ws(&url);
    }
    // 最近一次 UDP 发现到的 Hub 地址优先（Hub 换 IP 后自动更新，免重装）
    if let Some(url) = read_discovered_url() {
        return url;
    }
    // 安装/配置 UI 写入的 config.json（用户显式配置的 Hub 地址，覆盖 exe 尾部嵌入的旧地址）
    if let Some(url) = read_installed_config_url() {
        return url;
    }
    if let Some(config) = read_embedded_config() {
        if let Some(url) = config.server_url {
            return http_to_ws(&url);
        }
    }
    "ws://127.0.0.1:38921".to_string()
}
