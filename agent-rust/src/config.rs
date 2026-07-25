use serde::Deserialize;
use std::io::Read;

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

pub fn resolve_server_url() -> String {
    if let Some(url) = parse_server_args() {
        return http_to_ws(&url);
    }
    if let Some(config) = read_embedded_config() {
        if let Some(url) = config.server_url {
            return http_to_ws(&url);
        }
    }
    "ws://127.0.0.1:38921".to_string()
}
