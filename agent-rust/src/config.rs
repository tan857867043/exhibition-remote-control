use serde::Deserialize;

const EXE_CONFIG_GUID: [u8; 16] = [
    0xB9, 0x96, 0x01, 0x58, 0x80, 0x54, 0x4A, 0x19,
    0xB7, 0xF7, 0xE9, 0xBE, 0x44, 0x91, 0x4C, 0x18,
];

#[derive(Deserialize, Debug, Default)]
pub struct AgentConfig {
    pub server_url: Option<String>,
    pub device_name: Option<String>,
}

pub fn read_embedded_config() -> Option<AgentConfig> {
    let exe_path = std::env::current_exe().ok()?;
    let data = std::fs::read(exe_path).ok()?;
    let scan_start = data.len().saturating_sub(65536);
    let scan_end = data.len().saturating_sub(16);
    if scan_start > scan_end {
        return None;
    }
    let mut found: Option<usize> = None;
    for i in (scan_start..=scan_end).rev() {
        if data[i..i + 16] == EXE_CONFIG_GUID {
            found = Some(i);
            break;
        }
    }
    let guid_pos = found?;
    if guid_pos < 4 {
        return None;
    }
    let len_start = guid_pos - 4;
    let len_bytes: [u8; 4] = data[len_start..len_start + 4].try_into().ok()?;
    let config_len = u32::from_be_bytes(len_bytes) as usize;
    if config_len == 0 || len_start < config_len {
        return None;
    }
    let config_start = len_start - config_len;
    let config_bytes = &data[config_start..len_start];
    let config_str = std::str::from_utf8(config_bytes).ok()?;
    serde_json::from_str::<AgentConfig>(config_str).ok()
}

fn parse_server_args() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--server=") {
            return Some(value.to_string());
        }
        if arg == "--server" {
            if let Some(value) = args.next() {
                return Some(value);
            }
        }
    }
    None
}

fn http_to_ws(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else {
        url.to_string()
    }
}

pub fn resolve_server_url() -> String {
    let url = parse_server_args()
        .or_else(|| read_embedded_config().and_then(|c| c.server_url))
        .unwrap_or_else(|| "ws://127.0.0.1:38921".to_string());
    http_to_ws(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_to_ws_http() {
        assert_eq!(http_to_ws("http://example.com:8080"), "ws://example.com:8080");
    }

    #[test]
    fn test_http_to_ws_https() {
        assert_eq!(http_to_ws("https://example.com"), "wss://example.com");
    }

    #[test]
    fn test_http_to_ws_unchanged() {
        assert_eq!(http_to_ws("ws://127.0.0.1:38921"), "ws://127.0.0.1:38921");
        assert_eq!(http_to_ws("wss://secure.example.com"), "wss://secure.example.com");
    }

    #[test]
    fn test_agent_config_deserialize() {
        let json = r#"{"server_url":"http://hub.example.com:38921","device_name":"TestDevice"}"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.server_url, Some("http://hub.example.com:38921".to_string()));
        assert_eq!(config.device_name, Some("TestDevice".to_string()));
    }

    #[test]
    fn test_agent_config_partial() {
        let json = r#"{"server_url":"ws://10.0.0.1:38921"}"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.server_url, Some("ws://10.0.0.1:38921".to_string()));
        assert_eq!(config.device_name, None);
    }

    #[test]
    fn test_agent_config_default() {
        let config = AgentConfig::default();
        assert_eq!(config.server_url, None);
        assert_eq!(config.device_name, None);
    }

    #[test]
    fn test_read_embedded_config_none_for_tests() {
        let result = read_embedded_config();
        assert!(result.is_none());
    }
}
