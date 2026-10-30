// Release 构建不显示控制台窗口（避免开机自启时 cmd 闪烁）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

// mimalloc 强制回收 API：把堆中空闲页归还给操作系统。
// mimalloc 默认会保留释放的内存供复用，导致"控制画面结束 → 资源 drop"后
// Private/工作集仍停留在峰值附近；显式调用 mi_collect(true) 可立即归还。
extern "C" {
    fn mi_collect(force: bool);
}

mod dirty_rect;
mod capture;
mod encoder;
mod config;
mod service;
mod logger;
mod terminal;

use capture::{ScreenCapturer, CaptureError, GDICapturer};

use dirty_rect::GridManager;
use encoder::{build_binary_packet, extract_block_rgba_into, downsample_bgra_2x};
use enigo::{Enigo, MouseControllable, MouseButton};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sha2::{Sha256, Digest};
use xxhash_rust::xxh64::xxh64;
use std::collections::{VecDeque, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicBool, AtomicI32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, LazyLock, OnceLock};
use std::fs::File;
use std::io::{Read, Write};
use sysinfo::System;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tokio::net::UdpSocket;
use tokio_tungstenite::tungstenite::Message;
use turbojpeg::{Compressor, Image, PixelFormat};

/// 安全锁：Mutex 中毒不 panic，记日志后返回 PoisonError::into_inner 继续走（恢复最后一致状态）
macro_rules! lock_state {
    ($g:expr) => {
        match $g.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log_error!("[State] Mutex poisoned ({}), recovering last state", stringify!($g));
                poisoned.into_inner()
            }
        }
    };
}

#[cfg(windows)]
extern "system" {
    fn CreateMutexW(lpMutexAttributes: *const std::ffi::c_void, bInitialOwner: i32, lpName: *const u16) -> *mut std::ffi::c_void;
    fn GetLastError() -> u32;
    fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
    fn GetDiskFreeSpaceExW(
        lpDirectoryName: *const u16,
        lpFreeBytesAvailable: *mut u64,
        lpTotalNumberOfBytes: *mut u64,
        lpTotalNumberOfFreeBytes: *mut u64,
    ) -> i32;
    fn GetVolumeInformationW(
        lpRootPathName: *const u16,
        lpVolumeNameBuffer: *mut u16,
        nVolumeNameSize: u32,
        lpVolumeSerialNumber: *mut u32,
        lpMaximumComponentLength: *mut u32,
        lpFileSystemFlags: *mut u32,
        lpFileSystemNameBuffer: *mut u16,
        nFileSystemNameSize: u32,
    ) -> i32;
}

#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::*;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    LoadCursorW, GetCursorInfo,
    CURSORINFO, CURSORINFO_FLAGS,
    PeekMessageW, PM_NOREMOVE,
};

#[cfg(windows)]
fn send_input_raw(inputs: &[INPUT]) {
    let result = unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32)
    };
    if result == 0 {
        // SendInput 全量失败：记录错误码，便于诊断 UIPI/会话隔离导致的注入被拒
        let err = unsafe { GetLastError() };
        log_warn!("[Input] SendInput failed, GetLastError={}", err);
    }
}

/// UDP 广播发现 Hub 的共享密钥：Hub 回复必须携带 HMAC-SHA256 签名，
/// 防止局域网内任意主机伪造 HUB_AT 回复劫持 Agent 连接（未认证接管 = 变相 RCE）。
const DISCOVERY_SHARED_KEY: &[u8] = b"ExhibitionRemoteControl.HubDiscovery.2026.S3";

/// 计算 HUB_AT 回复的 HMAC-SHA256 十六进制签名
fn hub_at_hmac(payload: &str) -> String {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let Ok(mut mac) = <HmacSha256 as Mac>::new_from_slice(DISCOVERY_SHARED_KEY) else {
        return String::new();
    };
    mac.update(payload.as_bytes());
    let result = mac.finalize().into_bytes();
    let mut hex = String::with_capacity(64);
    for b in result.iter() {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// UDP 广播发现 Hub：向局域网广播查询，收到带签名的 `HUB_AT:ip:port:nonce:hmac` 即返回新地址。
/// 用于 Hub 更换 IP 后 Agent 自动更新连接地址（免重装）。
/// 连续连接失败触发，约 3s 超时；返回 None 表示网段内没有（通过认证的）Hub 响应。
async fn discover_hub() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    if sock.set_broadcast(true).is_err() {
        return None;
    }
    let payload = b"WHO_IS_EXHIBITION_HUB";
    let _ = sock.send_to(payload, "255.255.255.255:38922").await.ok();
    log_info!("[Discovery] Broadcast WHO_IS_EXHIBITION_HUB sent, waiting for hub reply...");

    let mut buf = [0u8; 256];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        let remain = deadline.saturating_duration_since(std::time::Instant::now());
        match tokio::time::timeout(remain, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _from))) => {
                let msg = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                if let Some(rest) = msg.strip_prefix("HUB_AT:") {
                    // 新版格式：HUB_AT:<ip>:<port>:<nonce>:<hmac>，只接受签名合法的回复
                    let parts: Vec<&str> = rest.split(':').collect();
                    if parts.len() == 4 {
                        let ip = parts[0];
                        let port = parts[1];
                        let nonce = parts[2];
                        let got_hmac = parts[3];
                        let payload_to_sign = format!("HUB_AT:{}:{}:{}", ip, port, nonce);
                        let expect = hub_at_hmac(&payload_to_sign);
                        if !expect.is_empty() && expect == got_hmac {
                            let url = format!("ws://{}:{}", ip, port);
                            log_info!("[Discovery] Authenticated hub found at '{}', updating connection address", url);
                            return Some(url);
                        }
                        log_warn!("[Discovery] Ignoring HUB_AT reply with invalid signature: '{}'", msg);
                    } else {
                        // 旧格式（无签名）或格式异常：不信任，仅记日志
                        log_warn!("[Discovery] Ignoring legacy/invalid HUB_AT reply: '{}'", msg);
                    }
                }
            }
            _ => {}
        }
    }
    log_warn!("[Discovery] No authenticated hub reply within 3s");
    None
}

// 重连退避上限（指数退避 2s→4s→...→60s）
const RETRY_MAX: u64 = 60;
// WebSocket 连接超时：旧地址失效时 TCP 连接可能长时间挂起（默认可达 21s+），
// 加 5s 超时让失败快速暴露，尽早触发 UDP 广播发现，加快 Hub 换 IP 后的自动恢复。
const CONNECT_TIMEOUT_SECS: u64 = 5;

/// 连接失败公共处理：更新退避、累计失败计数，达到阈值时触发 UDP 广播发现新 Hub。
async fn handle_connect_failure(retry_delay: &mut u64, fail_count: &mut u32, server_url: &mut String) {
    *retry_delay = (*retry_delay * 2).min(RETRY_MAX);
    *fail_count += 1;
    // 连续失败 ≥3 次：当前地址大概率已失效（如 Hub 换 IP），广播发现新 Hub
    if *fail_count >= 3 {
        *fail_count = 0;
        if let Some(new_url) = discover_hub().await {
            if new_url != *server_url {
                config::write_discovered_url(&new_url);
                log_info!("[Discovery] Connection address updated: {} -> {}", *server_url, new_url);
                *server_url = new_url;
                *retry_delay = 2; // 用新地址立即重试
            }
            return; // UDP 发现到了 Hub，用新地址重试
        }
        // 注意：不要回退到 localhost/127.0.0.1！
        // 如果回退到 localhost，下次从 Hub 前端下载 Agent 时注入的 URL 会是 localhost，
        // 导致其他机器的 Agent 拿到错误的 Hub 地址而无法连接。
        // 防火墙问题应由 Hub 安装时自动添加的 netsh 规则解决。
    }
}

#[cfg(windows)]
fn send_key(vk: u16, action: u8) {
    // Initialize message queue for current thread (required by SendInput for reliability)
    static MSG_QUEUE_INIT: OnceLock<()> = OnceLock::new();
    MSG_QUEUE_INIT.get_or_init(|| {
        unsafe {
            let mut msg = std::mem::zeroed();
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        }
    });

    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if action == 1 { flags |= KEYEVENTF_KEYUP; }
    let extended = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x6F, 0x90, 0xA3, 0xA5];
    if extended.contains(&vk) { flags |= KEYEVENTF_EXTENDEDKEY; }

    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_raw(&[input]);
}

#[cfg(windows)]
fn send_key_down_up(vk: u16, down: bool) {
    send_key(vk, if down { 0 } else { 1 });
}

#[cfg(windows)]
fn mouse_move_to(x: i32, y: i32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    static MSG_QUEUE_INIT: OnceLock<()> = OnceLock::new();
    MSG_QUEUE_INIT.get_or_init(|| {
        unsafe {
            let mut msg = std::mem::zeroed();
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        }
    });
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let abs_x = (x as f32 / screen_w as f32 * 65535.0) as i32;
    let abs_y = (y as f32 / screen_h as f32 * 65535.0) as i32;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: abs_x,
                dy: abs_y,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_raw(&[input]);
}

#[cfg(windows)]
fn mouse_button(button: u8, down: bool) {
    let flags = match (button, down) {
        (0, true) => MOUSEEVENTF_LEFTDOWN,
        (0, false) => MOUSEEVENTF_LEFTUP,
        (1, true) => MOUSEEVENTF_RIGHTDOWN,
        (1, false) => MOUSEEVENTF_RIGHTUP,
        (2, true) => MOUSEEVENTF_MIDDLEDOWN,
        (2, false) => MOUSEEVENTF_MIDDLEUP,
        _ => return,
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_raw(&[input]);
}

#[cfg(windows)]
fn mouse_scroll_y(delta: i32) {
    const WHEEL_DELTA: u32 = 120;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: (delta * WHEEL_DELTA as i32) as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_input_raw(&[input]);
}

#[cfg(not(windows))]
fn mouse_move_to(_x: i32, _y: i32) {}
#[cfg(not(windows))]
fn mouse_button(_button: u8, _down: bool) {}
#[cfg(not(windows))]
fn mouse_scroll_y(_delta: i32) {}

#[cfg(windows)]
fn get_disk_info_windows(root: &str) -> (u64, u64, String, String) {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;

    let root_wide: Vec<u16> = OsStr::new(root)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut free_bytes: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_free: u64 = 0;
    let has_space = unsafe {
        GetDiskFreeSpaceExW(
            root_wide.as_ptr(),
            &mut free_bytes,
            &mut total_bytes,
            &mut total_free,
        )
    } != 0;

    let drive_type = unsafe { GetDriveTypeW(root_wide.as_ptr()) };
    let type_name = match drive_type {
        2 => "removable".to_string(),
        3 => "fixed".to_string(),
        4 => "network".to_string(),
        5 => "cdrom".to_string(),
        6 => "ramdisk".to_string(),
        _ => "unknown".to_string(),
    };

    let label = get_volume_label_windows(&root_wide);

    if has_space {
        (total_bytes, free_bytes, type_name, label)
    } else {
        (0, 0, type_name, label)
    }
}

#[cfg(windows)]
fn get_volume_label_windows(root_wide: &[u16]) -> String {
    let mut name_buf: Vec<u16> = vec![0u16; 256];
    let mut fs_buf: Vec<u16> = vec![0u16; 64];
    let mut serial: u32 = 0;
    let mut max_comp: u32 = 0;
    let mut flags: u32 = 0;

    let success = unsafe {
        GetVolumeInformationW(
            root_wide.as_ptr(),
            name_buf.as_mut_ptr(),
            name_buf.len() as u32,
            &mut serial,
            &mut max_comp,
            &mut flags,
            fs_buf.as_mut_ptr(),
            fs_buf.len() as u32,
        )
    } != 0;

    if success {
        let len = name_buf.iter().position(|&c| c == 0).unwrap_or(0);
        String::from_utf16_lossy(&name_buf[..len])
    } else {
        String::new()
    }
}

#[cfg(not(windows))]
fn get_disk_info_windows(_root: &str) -> (u64, u64, String, String) {
    (0, 0, "unknown".to_string(), String::new())
}

// 全局 CPU 负载（由独立监控任务定期刷新，避免主循环高频 sysinfo 开销）
static CPU_LOAD: AtomicU32 = AtomicU32::new(0);
// 连接标志（断开时所有循环退出，等待重连）
static CONNECTED: AtomicBool = AtomicBool::new(false);
// 截图暂停标志（无订阅者时暂停截图以节省资源）
static CAPTURE_PAUSED: AtomicBool = AtomicBool::new(false);
// 缩略图快照请求标志（空闲暂停态收到 "snapshot" 指令时置位，视频线程采集一帧后清除）
static SNAPSHOT_REQUESTED: AtomicBool = AtomicBool::new(false);
// 前端丢弃脏区域帧后请求立即补一帧完整画面
static FORCE_KEY_REQUESTED: AtomicBool = AtomicBool::new(false);
// 画质档位（前端控制: 30=流畅, 50=均衡, 75=高清）
static QUALITY_PROFILE: AtomicI32 = AtomicI32::new(50);
// 全局 shutdown 标志：外部（如 Ctrl+C）设置后，重连等待循环可立即退出
static SHUTDOWN: AtomicBool = AtomicBool::new(false);
// 最近一次收到 WebSocket Pong 的时间戳（UNIX 秒），用于心跳超时检测
static LAST_PONG_TIME: AtomicU64 = AtomicU64::new(0);
// 屏幕尺寸缓存（进程内只初始化一次）：避免重连时反复创建/销毁 DXGI 设备导致驱动线程泄漏
static SCREEN_SIZE: Mutex<Option<(usize, usize)>> = Mutex::new(None);

// 文件传输状态
struct FileTransfer {
    file: File,
    file_name: String,
    total_chunks: u32,
    received_chunks: u32,
    total_size: u64,
    tmp_path: String,
    final_path: String,
    checksum: String, // 空字符串表示未提供
}
static FILE_TRANSFER: Mutex<Option<FileTransfer>> = Mutex::new(None);

struct DownloadState {
    file: std::fs::File,
    path: String,
    total_size: u64,
    id: String,
    window_size: u32,
    in_flight: u32,
    offset: u64,
    finished: bool,
}
static DOWNLOAD_STATE: Mutex<Option<DownloadState>> = Mutex::new(None);

struct UploadStateV2 {
    file: std::fs::File,
    path: String,
    name: String,
    total_size: u64,
    received_size: u64,
    done: bool,
}
static UPLOAD_STATE_V2: Mutex<Option<UploadStateV2>> = Mutex::new(None);
// 终端事件发送端（连接建立时设置，断开时清空；terminal_open 创建会话时 clone）
static TERM_EVENT_TX: Mutex<Option<std::sync::mpsc::Sender<terminal::TerminalEvent>>> = Mutex::new(None);
static PRESSED_KEYS: LazyLock<Mutex<HashSet<u16>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[cfg(windows)]
static CURSOR_CACHE: LazyLock<Vec<(isize, u8)>> = LazyLock::new(|| {
    let ids: Vec<(i32, u8)> = vec![
        (32512, 0),
        (32513, 1),
        (32649, 2),
        (32645, 3),
        (32644, 4),
        (32514, 5),
        (32515, 6),
        (32646, 7),
        (32643, 8),
        (32642, 9),
        (32650, 5),
        (32648, 255),
        (32516, 0),
        (32651, 0),
    ];
    let mut cache = Vec::new();
    for (res_id, type_id) in ids {
        unsafe {
            let name = windows::core::PCWSTR(res_id as *mut u16);
            if let Ok(hcursor) = LoadCursorW(None, name) {
                if !hcursor.is_invalid() {
                    cache.push((hcursor.0 as isize, type_id));
                }
            }
        }
    }
    cache
});

#[cfg(windows)]
fn get_current_cursor_type() -> u8 {
    let mut cursor_info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        flags: CURSORINFO_FLAGS(0),
        hCursor: windows::Win32::UI::WindowsAndMessaging::HCURSOR(0),
        ptScreenPos: windows::Win32::Foundation::POINT { x: 0, y: 0 },
    };
    unsafe {
        if GetCursorInfo(&mut cursor_info).is_ok() {
            if cursor_info.flags == CURSORINFO_FLAGS(0) {
                return 255;
            }
            let current_handle = cursor_info.hCursor.0 as isize;
            for (cached_handle, type_id) in CURSOR_CACHE.iter() {
                if *cached_handle == current_handle {
                    return *type_id;
                }
            }
        }
    }
    0
}

#[cfg(not(windows))]
fn get_current_cursor_type() -> u8 {
    0
}

// id 字段兼容 JSON 数字与字符串（如 upload 指令的 id 是 "ul_xxx" 字符串，
// 若按 u32 解析整个 ControlCmd 会失败导致指令被静默丢弃）
fn de_optional_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(deserializer)?;
    match v {
        Some(serde_json::Value::Number(n)) => Ok(n.as_u64().map(|x| x as u32)),
        Some(serde_json::Value::String(s)) => Ok(s.parse::<u32>().ok()),
        Some(_) => Ok(None),
        None => Ok(None),
    }
}

#[derive(Deserialize, Debug)]
struct ControlCmd {
    #[serde(default)]
    device_id: String,
    action: String,
    x: Option<i32>,
    y: Option<i32>,
    button: Option<String>,
    key: Option<String>,
    key_code: Option<u16>,
    value: Option<i32>,
    // 终端（terminal_*）指令字段：均用 Option，缺省不影响既有指令解析
    #[serde(default, deserialize_with = "de_optional_u32")]
    id: Option<u32>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    interface: Option<String>,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    mask: Option<String>,
    #[serde(default)]
    gateway: Option<String>,
    #[serde(default)]
    dns: Option<Vec<String>>,
}

// === 自适应画质引擎（参照 RDP/VNC 做法）===
struct QualityEngine {
    quality: i32,           // 当前 JPEG 质量
    min_quality: i32,       // 下限 (高速模式)
    max_quality: i32,       // 上限 (精细模式)
    framerate: u64,         // 当前目标 FPS
    keyframe_interval: u64, // 强制全帧间隔
    frame_count: u64,       // 帧计数
    target_rate_kbps: f32,  // 目标带宽上限 (KB/s)
    avg_encode_ms: f32,     // 滑动平均编码耗时
    avg_send_kbps: f32,     // 滑动平均发送速率
}

impl QualityEngine {
    fn new() -> Self {
        Self {
            quality: 70,
            min_quality: 60,
            max_quality: 75,
            framerate: 30,
            keyframe_interval: 60,
            frame_count: 0,
            target_rate_kbps: 150000.0,
            avg_encode_ms: 0.0,
            avg_send_kbps: 0.0,
        }
    }

    fn adapt(&mut self, change_ratio: f32, cpu_load: f32, encode_ms: u64, send_kbps: f32) {
        self.frame_count += 1;

        self.avg_encode_ms = self.avg_encode_ms * 0.7 + encode_ms as f32 * 0.3;
        self.avg_send_kbps = self.avg_send_kbps * 0.7 + send_kbps * 0.3;

        if change_ratio > 0.40 {
            self.framerate = 30;
            self.quality = (self.quality - 2).max(self.min_quality);
        } else if change_ratio > 0.15 {
            self.framerate = 30;
            self.quality = (self.quality - 1).max(self.min_quality);
        } else if change_ratio > 0.02 {
            self.framerate = 30;
            self.quality = (self.quality + 1).min(self.max_quality);
        } else {
            self.framerate = 30;
            self.quality = (self.quality + 2).min(self.max_quality);
        }

        if send_kbps > self.target_rate_kbps * 0.90 {
            self.framerate = self.framerate.min(15);
            self.quality = (self.quality - 3).max(self.min_quality);
        } else if send_kbps > self.target_rate_kbps * 0.75 {
            self.framerate = self.framerate.min(24);
            self.quality = (self.quality - 1).max(self.min_quality);
        }

        if cpu_load > 90.0 {
            self.framerate = self.framerate.min(15);
            self.quality = (self.quality - 3).max(self.min_quality);
        } else if cpu_load > 75.0 {
            self.framerate = self.framerate.min(24);
            self.quality = (self.quality - 1).max(self.min_quality);
        }

        if self.avg_encode_ms > 50.0 {
            self.quality = (self.quality - 8).max(self.min_quality);
        } else if self.avg_encode_ms < 15.0 && change_ratio < 0.10 {
            self.quality = (self.quality + 3).min(self.max_quality);
        }

        if change_ratio < 0.02 {
            self.quality = (self.quality + 2).min(self.max_quality);
        } else if change_ratio > 0.50 {
            self.quality = (self.quality - 5).max(self.min_quality);
        }

        // 最终 clamp 到档位边界内，确保任何路径都不会越界
        self.quality = self.quality.clamp(self.min_quality, self.max_quality);
        self.framerate = self.framerate.max(1);
    }

    fn need_keyframe(&self) -> bool {
        self.frame_count % self.keyframe_interval == 0
    }

    fn log_status(&self) {
        log_info!(
            "Q={} FPS={} enc={:.0}ms send={:.0}KB/s",
            self.quality, self.framerate, self.avg_encode_ms, self.avg_send_kbps
        );
    }
}

fn text_key_to_vk(key_str: &str) -> Option<u16> {
    match key_str {
        "Enter" => Some(0x0D),
        "Tab" => Some(0x09),
        " " | "Space" => Some(0x20),
        "Backspace" => Some(0x08),
        "Escape" => Some(0x1B),
        "Delete" => Some(0x2E),
        "Insert" => Some(0x2D),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        "ArrowUp" => Some(0x26),
        "ArrowDown" => Some(0x28),
        "ArrowLeft" => Some(0x25),
        "ArrowRight" => Some(0x27),
        "Shift" => Some(0x10),
        "Control" => Some(0x11),
        "Alt" => Some(0x12),
        "Meta" | "OS" => Some(0x5B),
        "CapsLock" => Some(0x14),
        s if s.len() == 1 => s.chars().next().map(|c| {
            // Windows VK 码用大写字母（A-Z = 0x41-0x5A）；小写字母必须转大写，
            // 否则 'a'=97(0x61) 会映射成 VK_NUMPAD1 等错误按键
            c.to_ascii_uppercase() as u16
        }),
        "F1" => Some(0x70), "F2" => Some(0x71), "F3" => Some(0x72),
        "F4" => Some(0x73), "F5" => Some(0x74), "F6" => Some(0x75),
        "F7" => Some(0x76), "F8" => Some(0x77), "F9" => Some(0x78),
        "F10" => Some(0x79), "F11" => Some(0x7A), "F12" => Some(0x7B),
        _ => None,
    }
}

/// 从字符串中提取冒号（或全角冒号）后面的内容，去除前后空白
fn extract_after_colon(line: &str) -> Option<String> {
    // 尝试半角冒号
    if let Some(pos) = line.find(':') {
        let val = &line[pos + 1..];
        let val = val.trim();
        if !val.is_empty() {
            return Some(val.to_string());
        }
    }
    // 尝试全角冒号
    if let Some(pos) = line.find('：') {
        let val = &line[pos + 1..];
        let val = val.trim();
        if !val.is_empty() {
            return Some(val.to_string());
        }
    }
    None
}

/// 判断一个 token 是否为 IPv6 地址样式（DNS 段续行中的 IPv6 地址，可能带 % zone-id，如 "fe80::1%8"）：
/// 可直接解析为 Ipv6Addr，或为含 ':' 的纯十六进制串（可带 '%' 后的区号后缀）
fn is_ipv6_like_token(s: &str) -> bool {
    if !s.contains(':') {
        return false;
    }
    if s.parse::<std::net::Ipv6Addr>().is_ok() {
        return true;
    }
    if let Some(pos) = s.find('%') {
        let core = &s[..pos];
        return core.parse::<std::net::Ipv6Addr>().is_ok()
            || (core.contains(':') && core.chars().all(|c| c.is_ascii_hexdigit() || c == ':'));
    }
    false
}

/// 按当前控制台 OEM 代码页解码 ipconfig /all 的输出字节流。
/// cmd 子进程默认以系统 OEM 代码页输出：中文系统为 GBK(936)，日文为 cp932，韩文为 cp949，
/// 英文为 437/1252。通过 chcp 探测实际代码页再选择编码，避免硬编码 GBK 导致非中文系统乱码。
#[cfg(windows)]
fn decode_console_output(bytes: &[u8]) -> String {
    let cp = std::process::Command::new("cmd")
        .args(["/C", "chcp"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .filter_map(|w| w.parse::<u32>().ok())
                .next()
        })
        .unwrap_or(936);
    let enc: &'static encoding_rs::Encoding = match cp {
        932 => encoding_rs::SHIFT_JIS,
        949 => encoding_rs::EUC_KR,
        65001 => encoding_rs::UTF_8,
        1252 => encoding_rs::WINDOWS_1252,
        437 => encoding_rs::WINDOWS_1252,
        _ => encoding_rs::GBK, // 936 及其他未知代码页按 GBK 处理
    };
    let (decoded, _, _) = enc.decode(bytes);
    decoded.into_owned()
}



fn send_download_chunk(ack_tx: &tokio::sync::mpsc::Sender<Message>) {
    let mut ds = lock_state!(DOWNLOAD_STATE);
    let state = match &mut *ds {
        Some(s) => s,
        None => return,
    };

    if state.finished {
        return;
    }

    let remaining = state.total_size - state.offset;
    let read_size = std::cmp::min(16380, remaining as usize);

    let mut buffer = vec![0u8; read_size];
    let bytes_read = state.file.read(&mut buffer).unwrap_or(0);
    if bytes_read == 0 {
        state.finished = true;
        return;
    }

    buffer.truncate(bytes_read);

    let is_last = state.offset + bytes_read as u64 >= state.total_size;
    // 新下载协议头：[0xF1, isLast, 0, 0]。旧的 0x01 头与脏区域帧头（0x01 + x=0）冲突，
    // 会被前端误判为视频帧，这里改用专用标识
    let header: [u8; 4] = [0xF1, if is_last { 1 } else { 0 }, 0, 0];

    let mut packet = Vec::with_capacity(4 + bytes_read);
    packet.extend_from_slice(&header);
    packet.extend_from_slice(&buffer);

    if ack_tx.try_send(Message::Binary(packet)).is_err() {
        return;
    }

    state.offset += bytes_read as u64;
    state.in_flight += 1;

    if is_last {
        state.finished = true;
    }
}

fn handle_binary_msg(data: &[u8], ack_tx: &tokio::sync::mpsc::Sender<Message>) {
    if data.is_empty() { return; }
    match data[0] {
        0x01 => {
            if data.len() < 6 { return; }
            let x = data[2] as i32 | ((data[3] as i32) << 8);
            let y = data[4] as i32 | ((data[5] as i32) << 8);
            mouse_move_to(x, y);
        }
        0x02 => {
            if data.len() < 3 { return; }
            let button = match data[1] {
                0 => 0,
                1 => 1,
                2 => 2,
                _ => return,
            };
            mouse_button(button, data[2] == 1);
        }
        0x03 => {
            if data.len() < 4 { return; }
            let delta = (data[2] as i16) | ((data[3] as i16) << 8);
            if delta != 0 {
                mouse_scroll_y(delta as i32);
            }
        }
        0x04 => {
            if data.len() < 2 { return; }
            let count = data[1] as usize;
            let mut offset = 2;
            for _ in 0..count {
                if offset + 3 > data.len() { break; }
                let action = data[offset];
                let vk = data[offset + 1] as u16 | ((data[offset + 2] as u16) << 8);
                offset += 3;

                // Track pressed keys
                if action == 0 || action == 2 {
                    lock_state!(PRESSED_KEYS).insert(vk);
                } else {
                    lock_state!(PRESSED_KEYS).remove(&vk);
                }

                // Send raw keyboard event via windows crate
                #[cfg(windows)]
                send_key(vk, action);
            }
        }
        0x05 => {
            if data.len() < 2 { return; }
            if data[1] == 10 {
                #[cfg(windows)]
                {
                    send_key_down_up(0x11, true);  // Ctrl down
                    send_key_down_up(0x12, true);  // Alt down
                    send_key_down_up(0x2E, true);  // Delete down
                    send_key_down_up(0x2E, false); // Delete up
                    send_key_down_up(0x12, false); // Alt up
                    send_key_down_up(0x11, false); // Ctrl up
                }
            }
        }
        0x06 => {
            // File chunk: [0x06, chunk_hi, chunk_lo, total_hi, total_lo, ...data]
            if data.len() < 6 { return; }
            let _chunk_index = ((data[1] as u16) << 8) | (data[2] as u16);
            let total = (((data[3] as u16) << 8) | (data[4] as u16)) as u32;
            let chunk_data = &data[5..];
            let mut ft = lock_state!(FILE_TRANSFER);
            if let Some(ref mut transfer) = *ft {
                if let Err(e) = transfer.file.write_all(chunk_data) {
                    let error_type = match e.kind() {
                        std::io::ErrorKind::StorageFull => "disk_full",
                        std::io::ErrorKind::PermissionDenied => "access_denied",
                        _ => {
                            if e.raw_os_error() == Some(112) { "disk_full" }
                            else { "write_error" }
                        }
                    };
                    let tmp_path = transfer.tmp_path.clone();
                    *ft = None;
                    drop(ft);
                    let _ = std::fs::remove_file(&tmp_path);
                    let reply = format!(r#"{{"action":"file_error","error":"{}"}}"#, error_type);
                    let _ = ack_tx.try_send(Message::Text(reply));
                    return;
                }
                transfer.received_chunks += 1;
                // MeshCentral-style: batch ACK every 8 chunks (or on last chunk)
                if transfer.received_chunks % 8 == 0 || transfer.received_chunks == total {
                    let ack = format!(r#"{{"action":"file_ack","chunk":{}}}"#, transfer.received_chunks - 1);
                    let _ = ack_tx.try_send(Message::Text(ack));
                }
            }
        }
        0x07 => {
            // File transfer EOF
            let mut ft = lock_state!(FILE_TRANSFER);
            if let Some(mut transfer) = ft.take() {
                let _ = transfer.file.flush();
                let tmp_path = transfer.tmp_path.clone();
                let final_path = transfer.final_path.clone();
                let file_name = transfer.file_name.clone();
                let total_size = transfer.total_size;
                let expected_checksum = transfer.checksum.clone();
                drop(transfer); // 关闭文件句柄
                drop(ft);

                // 流式计算 SHA-256，避免大文件整读进内存导致 OOM
                let mut hasher = Sha256::new();
                let mut read_ok = true;
                match std::fs::File::open(&tmp_path) {
                    Ok(mut f) => {
                        let mut hash_buf = vec![0u8; 1024 * 1024];
                        loop {
                            match f.read(&mut hash_buf) {
                                Ok(0) => break,
                                Ok(n) => hasher.update(&hash_buf[..n]),
                                Err(e) => {
                                    log_error!("Failed to read tmp file for checksum: {}", e);
                                    read_ok = false;
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log_error!("Failed to read tmp file for checksum: {}", e);
                        read_ok = false;
                    }
                }

                if !read_ok {
                    let _ = std::fs::remove_file(&tmp_path);
                    return;
                }

                let checksum_hex = format!("{:x}", hasher.finalize());

                // 校验和比对
                if !expected_checksum.is_empty() && checksum_hex != expected_checksum {
                    let _ = std::fs::remove_file(&tmp_path);
                    let _ = ack_tx.try_send(Message::Text(
                        r#"{"action":"file_error","error":"checksum_mismatch"}"#.into()
                    ));
                    return;
                }

                // 重命名 .tmp 到最终文件
                if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
                    log_error!("Failed to rename tmp file: {}", e);
                    let _ = std::fs::remove_file(&tmp_path);
                    return;
                }

                let done = format!(
                    r#"{{"action":"file_done","file_name":"{}","path":"{}","size":{},"checksum":"{}"}}"#,
                    file_name, final_path.replace('\\', "\\\\"), total_size, checksum_hex
                );
                let _ = ack_tx.try_send(Message::Text(done));
                log_info!("File transfer complete: {} ({} bytes)", file_name, total_size);
            }
        }
        0x09 => {
            let mut us = lock_state!(UPLOAD_STATE_V2);
            if let Some(ref mut state) = *us {
                if !state.done {
                    let chunk_data = &data[1..];
                    if let Err(e) = state.file.write_all(chunk_data) {
                        log_error!("Failed to write upload chunk: {}", e);
                        return;
                    }
                    state.received_size += chunk_data.len() as u64;
                    if let Err(e) = state.file.flush() {
                        log_error!("Failed to flush upload file: {}", e);
                    }
                }
            }
        }
        _ => {}
    }
}

/// 取已排序切片的百分位值（0.5 = p50, 0.95 = p95）
fn percentile(sorted: &[u32], p: f32) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() - 1) as f32 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// 计算 CPU 平均使用率
fn cpus_avg(sys: &System) -> f32 {
    let cpus = sys.cpus();
    if cpus.is_empty() { 0.0 } else {
        cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
    }
}

fn send_list_dir(ack_tx: &tokio::sync::mpsc::Sender<Message>, path: &str) {
    let path = path.trim_end_matches('\\').trim().to_string();
    log_info!("[Agent] send_list_dir called, path: '{}'", path);

    if path.is_empty() {
        let mut drives = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if std::path::Path::new(&drive).exists() {
                let (total, free, dtype, label) = get_disk_info_windows(&drive);
                log_info!("[Agent] Found drive: {} total={} free={} type={} label={}", drive, total, free, dtype, label);
                drives.push(format!(
                    r#"{{"name":"{}","size":{},"free":{},"is_dir":true,"modified":"","type":"disk","disk_type":"{}","label":"{}"}}"#,
                    drive.replace('\\', "\\\\"),
                    total, free,
                    dtype,
                    label.replace('\\', "\\\\").replace('"', "\\\"")
                ));
            }
        }
        let reply = format!(
            r#"{{"action":"list_dir_result","path":"","entries":[{}]}}"#,
            drives.join(",")
        );
        log_info!("[Agent] Sending list_dir_result (drives): {} drives", drives.len());
        let _ = ack_tx.try_send(Message::Text(reply));
        return;
    }

    match std::fs::read_dir(&path) {
        Ok(entries) => {
            let mut result = Vec::new();
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let metadata = entry.metadata().ok();
                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = metadata.and_then(|m| m.modified().ok())
                    .map(|t| {
                        let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                        format!("{}", duration.as_secs())
                    }).unwrap_or_default();

                result.push(format!(
                    r#"{{"name":"{}","size":{},"is_dir":{},"modified":"{}"}}"#,
                    name.replace('\\', "\\\\").replace('"', "\\\""),
                    size, is_dir, modified
                ));
            }
            let reply = format!(
                r#"{{"action":"list_dir_result","path":"{}","entries":[{}]}}"#,
                path.replace('\\', "\\\\"), result.join(",")
            );
            log_info!("[Agent] Sending list_dir_result for '{}': {} entries", path, result.len());
            let _ = ack_tx.try_send(Message::Text(reply));
        }
        Err(e) => {
            log_error!("[Agent] list_dir error for '{}': {}", path, e);
            let _ = ack_tx.try_send(Message::Text(
                format!(r#"{{"action":"list_dir_error","error":"{}"}}"#, e)
            ));
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    logger::init();
    // DPI 感知：让截图与鼠标坐标在高 DPI 屏幕上保持正确（Per-Monitor V2）
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::HiDpi::*;
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    // 全局 panic hook: 任何线程 panic 都打日志，不崩溃
    std::panic::set_hook(Box::new(|info| {
        log_error!("[PANIC] {}", info);
        service::log(&format!("[PANIC] {}", info));
    }));

    // === CLI 参数解析（在 tokio runtime 内同步执行）===
    let args: Vec<String> = std::env::args().collect();

    service::log(&format!("[Agent] Started, args={:?}, exe={}", args,
        std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()));

    // ------ --uninstall-ui：双击「卸载.bat」或控制面板替代，自动提权 + 弹提示 ------
    if args.len() > 1 && args[1] == "--uninstall-ui" {
        if !service::is_admin() {
            let _ = service::elevate_self();
            return;
        }
        match service::uninstall_service() {
            Ok(()) => service::msgbox(
                "Exhibition Agent 已卸载成功（服务 + 启动项 + 安装目录均已清理）",
                "卸载完成",
                "info",
            ),
            Err(e) => service::msgbox(
                &format!("卸载失败：\n{}", e),
                "卸载失败",
                "error",
            ),
        }
        return;
    }

    // ------ --config-ui-write=<url>：非管理员提权后的写配置分支（避免用户输入丢失）------
    if let Some(rest) = args.get(1).and_then(|a| a.strip_prefix("--config-ui-write=")) {
        let cfg_path = "C:\\Program Files\\ExhibitionAgent\\config.json";
        let _ = std::fs::create_dir_all("C:\\Program Files\\ExhibitionAgent");
        let new = rest.trim().to_string();
        if !new.is_empty() {
            let _ = std::fs::write(
                cfg_path,
                serde_json::json!({ "server_url": new }).to_string(),
            );
            // 用户显式配置优先：清除 UDP 发现缓存，避免旧的发现地址压过新配置
            crate::config::clear_discovered_url();
        }
        // 杀掉 user-agent worker，让守护进程自动拉新的（读新地址）
        let _ = std::process::Command::new("taskkill")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .args(["/F", "/IM", "exhibition-agent.exe", "/FI", "SESSIONNAME ge 0"])
            .output();
        service::msgbox(
            &format!("服务器地址已更新为：\n{}\nworker 进程已重启，正在重新连接 Hub ...", new),
            "配置完成",
            "info",
        );
        return;
    }
    // ------ --config-ui：手动双击输入框写地址（非管理员经提权实例承接写入，避免输入丢失）------
    if args.len() > 1 && args[1] == "--config-ui" {
        let cfg_path = "C:\\Program Files\\ExhibitionAgent\\config.json";
        let _ = std::fs::create_dir_all("C:\\Program Files\\ExhibitionAgent");
        let cur_url = crate::config::read_embedded_config()
            .and_then(|c| c.server_url)
            .unwrap_or_else(|| crate::config::resolve_server_url());
        if let Some(new) = service::input_box(
            "请输入 Hub 服务器地址（示例：ws://192.168.1.10:38921/ws）\n取消将不做修改",
            "配置 Exhibition Agent 服务器地址",
            &cur_url,
        ) {
            if service::is_admin() {
                let _ = std::fs::write(
                    cfg_path,
                    serde_json::json!({ "server_url": new }).to_string(),
                );
                // 用户显式配置优先：清除 UDP 发现缓存，避免旧的发现地址压过新配置
                crate::config::clear_discovered_url();
                // 杀掉 user-agent worker，让守护进程自动拉新的（读新地址）
                let _ = std::process::Command::new("taskkill")
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .args(["/F", "/IM", "exhibition-agent.exe", "/FI", "SESSIONNAME ge 0"])
                    .output();
                service::msgbox(
                    &format!("服务器地址已更新为：\n{}\nworker 进程已重启，正在重新连接 Hub ...", new),
                    "配置完成",
                    "info",
                );
            } else {
                // 把用户输入的地址经 CLI 参数传给提权实例，由 --config-ui-write 分支完成写入与提示
                let _ = service::elevate_self_with_arg(&format!("--config-ui-write={}", new));
            }
        }
        return;
    }

    if args.len() > 1 {
        match args[1].as_str() {
            "--install" => {
                let server_url = if args.len() > 3 && args[2] == "--server" {
                    args[3].clone()
                } else {
                    config::read_embedded_config()
                        .and_then(|c| c.server_url)
                        .unwrap_or_else(|| config::resolve_server_url())
                };
                log_info!("Installing ExhibitionAgent with server: {}", server_url);
                match service::install_service(&server_url) {
                    Ok(()) => log_info!("ExhibitionAgent installed successfully"),
                    Err(e) => log_error!("Failed to install service: {}", e),
                }
                return;
            }
            "--uninstall" => {
                log_info!("Uninstalling ExhibitionAgent...");
                match service::uninstall_service() {
                    Ok(()) => log_info!("ExhibitionAgent uninstalled successfully"),
                    Err(e) => log_error!("Failed to uninstall: {}", e),
                }
                return;
            }
            "--service" => {
                // Session 0 守护进程（SCM 启动的）：不截图不键鼠，只做 session-guard watchdog。
                // run_as_service_daemon 会注册 SCM 状态（否则 30s 超时被 SCM 停止），
                // 并响应 sc stop 优雅退出。
                log_info!("[ServiceDaemon] ExhibitionAgent --service (SessionGuard watchdog) starting...");
                service::run_as_service_daemon();
                return;
            }
            "--run" => {
                // 单实例互斥：同一登录会话内只允许一个 worker 实例（防止重复自启导致双截图/双键鼠注入）
                // 句柄存 static 防止被清理（进程存活期间互斥一直持有）
                static MUTEX_HANDLE: AtomicUsize = AtomicUsize::new(0);
                let mutex_name = "Local\\ExhibitionAgentWorker".encode_utf16()
                    .chain(std::iter::once(0))
                    .collect::<Vec<u16>>();
                let (mutex_handle, already_exists) = unsafe {
                    let h = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
                    (h, GetLastError() == 183) // ERROR_ALREADY_EXISTS
                };
                if already_exists {
                    log_info!("[RunWorker] Another worker instance is running, exiting");
                    return;
                }
                MUTEX_HANDLE.store(mutex_handle as usize, Ordering::Relaxed);
                // 用户态 worker（HKLM Run / 守护进程拉起的）：直接进入干活逻辑（DXGI + SendInput）
                service::log("[Worker] --run mode, entering worker main loop...");
                log_info!("[RunWorker] ExhibitionAgent --run starting (user-mode worker)...");
            }
            "--help" | "-h" => {
                log_info!("Usage: exhibition-agent.exe [OPTIONS]");
                log_info!("  (无参数)                      自动更新（若检测到新版本），之后进入 worker 模式");
                log_info!("  --install [--server <url>]    以管理员身份安装 Windows 服务 + HKLM Run 启动项");
                log_info!("  --uninstall                   卸载服务、启动项、安装目录");
                log_info!("  --service                     SCM 服务专用模式（守护 watchdog，不要手动双击）");
                log_info!("  --run                         用户态 worker 模式（截图 + 键鼠注入）");
                log_info!("  --server <url>                单次运行指定 Hub 地址");
                return;
            }
            "--server" => {
                // 手动临时指定 Hub 地址，走 worker（用于测试）
                if args.len() > 2 {
                    log_info!("[RunWorker] Using custom server: {}", args[2]);
                    // 把这个地址写进 config.json，下次 --run 继续用
                    let cfg_dir = "C:\\Program Files\\ExhibitionAgent";
                    let _ = std::fs::create_dir_all(cfg_dir);
                    let cfg_path = format!("{}\\config.json", cfg_dir);
                    let _ = std::fs::write(&cfg_path,
                        serde_json::json!({ "server_url": args[2] }).to_string());
                }
            }
            other => {
                log_error!("Unknown option: {}", other);
                log_info!("Run with --help to see options.");
                return;
            }
        }
    } else {
        // ==================== 无参数 = 双击启动（用户最常用入口，0 命令行）====================
        service::log("[Main] Entering no-arg branch");
        let install_exe = format!("{}\\exhibition-agent.exe", "C:\\Program Files\\ExhibitionAgent");
        let current_exe = std::env::current_exe().unwrap_or_default().to_string_lossy().to_string();
        let stamp_path = format!("{}\\exhibition_agent_install_url.tmp", std::env::temp_dir().to_string_lossy());
        let pending_url: Option<String> = std::fs::read_to_string(&stamp_path).ok()
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if pending_url.is_some() { let _ = std::fs::remove_file(&stamp_path); }

        service::log(&format!("[Main] is_service_installed={}, current_exe={}, install_exe={}",
            service::is_service_installed(), current_exe, install_exe));

        if service::is_service_installed() {
            // ---- 已安装：双击新版本 → 静默自动更新（不弹框）----
            if !current_exe.is_empty() && !current_exe.eq_ignore_ascii_case(&install_exe) {
                if !service::is_admin() { let _ = service::elevate_self(); return; }
                let url = pending_url.unwrap_or_else(|| config::resolve_server_url());
                match service::install_service(&url) {
                    Ok(()) => {
                        let http = service::ws_to_http_url(&url);
                        service::open_url_in_browser(&http);
                    }
                    Err(e) => service::msgbox(&format!("更新失败：\n{}", e), "更新失败", "error"),
                }
                return;
            }
            // 已安装且就是安装目录的 exe → 直接进入 worker 模式（完全不弹框）
            log_info!("[RunWorker] Service installed, entering worker mode directly.");
        } else if let Some(url) = pending_url.filter(|_| service::is_admin()) {
            // 非管理员提权后走到这，用户只输入一次地址
            match service::install_service(&url) {
                Ok(()) => {
                    let http = service::ws_to_http_url(&url);
                    service::msgbox(
                        &format!("✅ 安装完成！\n\n已设置开机自启，worker 已启动。\n桌面已创建快捷方式：\n  • Exhibition 控制台\n  • 配置服务器地址\n  • 卸载 Exhibition Agent",
                        ),
                        "Exhibition Agent 安装成功", "info",
                    );
                    service::open_url_in_browser(&http);
                }
                Err(e) => service::msgbox(&format!("安装失败：\n{}", e), "安装失败", "error"),
            }
            return;
        } else {
            // ---- 首次安装 ----
            // 先尝试从 exe 尾部读注入的配置（前端下载时 Hub 会自动附加）
            service::log("[Main] Checking injected config...");
            let embedded = config::read_embedded_config();
            service::log(&format!("[Main] read_embedded_config returned: {:?}", embedded));
            let injected_url = embedded
                .and_then(|c| c.server_url)
                .filter(|u| u != "ws://127.0.0.1:38921" && u != "ws://localhost:38921");
            service::log(&format!("[Main] injected_url: {:?}", injected_url));
            if let Some(url) = injected_url {
                // 从远端 Hub 下载的 exe：URL 已注入，直接静默安装，不弹任何输入框
                service::log(&format!("[Install] Detected injected server_url: {}, installing silently...", url));
                log_info!("[Install] Detected injected server_url: {}, installing silently...", url);
                if !service::is_admin() {
                    let _ = std::fs::write(&stamp_path, &url);
                    service::log("[Install] Not admin, elevating...");
                    let _ = service::elevate_self();
                    return;
                }
                match service::install_service(&url) {
                    Ok(()) => {
                        service::log("[Install] Service installed successfully");
                        let http = service::ws_to_http_url(&url);
                        service::msgbox(
                            "✅ 安装完成！\n\n已设置开机自启，worker 已启动。\n桌面已创建快捷方式，双击「Exhibition 控制台」即可使用。",
                            "Exhibition Agent 安装成功", "info",
                        );
                        service::open_url_in_browser(&http);
                        return;
                    }
                    Err(e) => {
                        service::log(&format!("[Install] Service install FAILED: {}", e));
                        service::msgbox(&format!("安装失败：\n{}", e), "安装失败", "error");
                    }
                }
                return;
            }

            // 没有注入的配置 → 本地测试场景，弹输入框（默认已填好 localhost）
            let default_url = config::resolve_server_url();
            let user_input = service::input_box(
                "请输入 Hub 服务器地址（本机测试直接点确定即可）：",
                "Exhibition Agent 安装",
                &default_url,
            );
            let url = match user_input {
                Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => {
                    log_info!("[RunWorker] Cancelled install, entering temporary worker mode.");
                    String::new()
                }
            };
            if !url.is_empty() {
                if !service::is_admin() {
                    let _ = std::fs::write(&stamp_path, &url);
                    match service::elevate_self() {
                        Ok(()) => return,
                        Err(e) => {
                            service::msgbox(
                                &format!("需要管理员权限：\n{}\n请右键 exe →「以管理员身份运行」", e),
                                "需要管理员权限", "warning",
                            );
                            let _ = std::fs::remove_file(&stamp_path);
                            return;
                        }
                    }
                }
                match service::install_service(&url) {
                    Ok(()) => {
                        let http = service::ws_to_http_url(&url);
                        service::msgbox(
                            "✅ 安装完成！\n\n已设置开机自启，worker 已启动。\n桌面已创建快捷方式，双击「Exhibition 控制台」即可使用。",
                            "Exhibition Agent 安装成功", "info",
                        );
                        service::open_url_in_browser(&http);
                        return;
                    }
                    Err(e) => {
                        service::msgbox(&format!("安装失败：\n{}", e), "安装失败", "error");
                        return;
                    }
                }
            }
        }
    }

    // === 原有的 main 逻辑保持不变 ===
    log_info!("Exhibition Agent starting (industry-grade pipeline)...");

    // 收集系统信息（MAC、CPU 品牌、内存、主机名）：全部放进子线程 + 8s 总超时。
    // sysinfo 的网卡枚举/系统刷新在异常系统状态（VPN 虚拟网卡、部分驱动异常）下会无限期挂起，
    // 曾导致 agent 卡死在 "Exhibition Agent starting" 之后、永远无法连接 hub。
    // 超时则用默认值继续，绝不让任何 sysinfo 调用阻塞启动流程。
    let (mac_addr, cpu_brand, mem_gb, host_name) = {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut mac = String::new();
            {
                let networks = sysinfo::Networks::new_with_refreshed_list();
                // 收集所有候选物理网卡 MAC，排序后取第一个：
                // sysinfo 的 Networks 是 HashMap，迭代顺序不稳定，直接取第一个 break 会导致
                // 多物理网卡时每次启动选到不同网卡 → MAC 漂移 → 设备 ID 漂移。排序保证稳定。
                let mut candidates: Vec<String> = Vec::new();
                for (name, data) in &networks {
                    let n = name.to_lowercase();
                    // 跳过回环与常见虚拟网卡（VMware/VirtualBox/Hyper-V/WSL/VPN/蓝牙/隧道），
                    // 这些网卡 MAC 不稳定，会导致设备 ID 漂移。
                    if n == "lo" || n.starts_with("loopback")
                        || n.starts_with("vmnet") || n.starts_with("vmware")
                        || n.contains("virtualbox") || n.contains("vbox")
                        || n.starts_with("vethernet") // Hyper-V / WSL
                        || n.starts_with("tailscale") || n.starts_with("wireguard")
                        || n.starts_with("tap-") || n.starts_with("tun")
                        || n.contains("bluetooth") || n.contains("isatap")
                        || n.contains("teredo")
                    {
                        continue;
                    }
                    let m = data.mac_address();
                    if m.is_unspecified() {
                        continue;
                    }
                    candidates.push(m.to_string()); // Display: aa:bb:cc:dd:ee:ff
                }
                candidates.sort_unstable();
                if let Some(first) = candidates.first() {
                    // 大写冒号格式 D8:5E:D3:A3:17:62（与 ipconfig / Get-NetAdapter 输出一致）
                    mac = first.to_uppercase();
                }
            }
            let mut sys = System::new();
            sys.refresh_cpu();
            sys.refresh_memory();
            let host = System::host_name().unwrap_or_else(|| "Unknown Device".to_string());
            let cpu = sys.cpus().first().map(|c| c.brand()).unwrap_or("Unknown CPU").to_string();
            let mem = (sys.total_memory() as f64 / 1_073_741_824.0).round() as u64;
            let _ = tx.send((mac, cpu, mem, host));
        });
        rx.recv_timeout(std::time::Duration::from_secs(8)).unwrap_or_else(|_| {
            ("".to_string(), "Unknown CPU".to_string(), 0, "Unknown Device".to_string())
        })
    };
    // 启动插桩：确认信息收集已越过（若卡死则此处不打印）
    log_info!("[Boot] System info collected: mac='{}' cpu='{}' mem={}GB host='{}'",
        mac_addr, cpu_brand, mem_gb, host_name);

    // Generate or load Device ID。
    // 旧实现把 .device_id 写在当前工作目录：从不同目录启动（Downloads/Program Files/服务）会生成不同设备 ID，
    // 导致前端看到设备"消失"或出现重复设备。改为固定路径 %LOCALAPPDATA%\ExhibitionAgent\device_id，
    // 未找到时用 MAC+主机名生成稳定 ID（跨重启/跨启动方式一致），并迁移旧 CWD 下的 .device_id。
    let device_id_path = {
        let dir = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            std::env::var("USERPROFILE")
                .map(|p| format!("{}\\AppData\\Local", p))
                .unwrap_or_else(|_| ".".to_string())
        });
        Path::new(&dir).join("ExhibitionAgent").join("device_id")
    };
    let device_id = std::fs::read_to_string(&device_id_path)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            // 迁移旧版 CWD 下的 .device_id，避免用户设备 ID 突变
            if let Ok(old) = std::fs::read_to_string(".device_id") {
                let old = old.trim().to_string();
                if !old.is_empty() {
                    if let Some(parent) = device_id_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                        let _ = std::fs::write(&device_id_path, &old);
                    }
                    return old;
                }
            }
            // 生成稳定 ID：MAC + 主机名（硬件相关，跨启动不变）
            let base = format!("{}_{}", host_name, mac_addr);
            let id_str = format!("{:08x}", crc32fast::hash(base.as_bytes()));
            if let Some(parent) = device_id_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&device_id_path, &id_str);
            id_str
        });

    let os_name = format!("{} {}", System::name().unwrap_or_else(|| "Unknown OS".to_string()), System::os_version().unwrap_or_default());
    let host_name_encoded = host_name.replace(" ", "%20");
    let os_name_encoded = os_name.replace(" ", "%20");
    let cpu_brand_encoded = cpu_brand.replace(" ", "%20");
    let mac_encoded = mac_addr.replace(" ", "%20");
    let mut server_url = config::resolve_server_url();
    let mut retry_delay = 2u64; // 最小 2s，避免 Hub 刚挂掉时狂连
    let mut fail_count: u32 = 0; // 连续失败计数：≥3 次后触发 UDP 广播发现 Hub

    // === 全局 CPU 监控线程（单例，进程生命周期内只创建一次）===
    // 旧实现每轮重连都 spawn 新任务，存在竞态：旧任务在 sleep 期间新连接建立，
    // CONNECTED 重新变 true，旧任务不会退出 → 任务堆积 + 内存泄漏。
    // 且 refresh_cpu() 是阻塞调用：放在 2-worker 的 tokio 运行时上会卡住 worker，
    // 导致 control_handler 无法及时读取 WebSocket（Hub 写超时→连接被断开）。
    // 故改用独立 OS 线程 + std::thread::sleep，完全隔离阻塞开销。
    std::thread::spawn(move || {
        // 延迟初始化 sysinfo：启动早期信息收集子线程也在用 sysinfo，若并发初始化且系统
        // 网卡/刷新异常（VPN 虚拟网卡等）可能导致全局锁竞争死锁。只在真正需要刷新 CPU 时才创建。
        let mut sys: Option<System> = None;
        let mut refresh_count: u32 = 0;
        let mut idle_count: u32 = 0;
        loop {
            if CONNECTED.load(Ordering::Relaxed) && !CAPTURE_PAUSED.load(Ordering::Relaxed) {
                if sys.is_none() {
                    log_info!("[CPU] Initializing System (lazy)");
                    sys = Some(System::new());
                }
                if let Some(s) = sys.as_mut() {
                    s.refresh_cpu();
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if !CONNECTED.load(Ordering::Relaxed) { continue; }
                    s.refresh_cpu();
                    let load = cpus_avg(s);
                    CPU_LOAD.store((load * 10.0) as u32, Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    refresh_count += 1;
                    // 每 5 分钟（约 600 次 500ms 循环）重建 System，释放内部缓存
                    if refresh_count >= 600 {
                        sys = Some(System::new());
                        refresh_count = 0;
                        log_info!("[CPU] System instance rebuilt to clear internal cache");
                    }
                }
            } else {
                // 空闲时低频心跳，不做任何刷新
                CPU_LOAD.store(0, Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_secs(1));
                idle_count += 1;
                // 每 5 分钟（约 300 次 1s 循环）输出一次内存 RSS
                if idle_count >= 300 {
                    let mut temp_sys = System::new();
                    if let Ok(pid) = sysinfo::get_current_pid() {
                        temp_sys.refresh_process(pid);
                        if let Some(proc) = temp_sys.process(pid) {
                            log_info!("[Memory] RSS={:.1}MB", proc.memory() as f64 / 1024.0 / 1024.0);
                        }
                    }
                    idle_count = 0;
                }
            }
        }
    });

    // tokio task 生命周期：重连前 abort 旧 task，避免半开 WebSocket 连接导致任务永久驻留
    // 必须声明在循环外部，确保跨迭代保存旧 handle
    let mut priority_sender_handle: Option<tokio::task::JoinHandle<()>> = None;
    let mut control_handler_handle: Option<tokio::task::JoinHandle<()>> = None;

    'reconnect: loop {
        // 启动插桩：确认已进入重连循环（若卡死在前面则此处不打印）
        log_info!("[Reconnect] Entering reconnect loop");
        // 初始为暂停状态，等待 Hub 发来 resume 指令后才开始截图
        CAPTURE_PAUSED.store(true, Ordering::Relaxed);

        // === 先 abort 上一轮的旧 task，防止内存泄漏 ===
        if let Some(h) = priority_sender_handle.take() {
            h.abort();
            log_info!("[Reconnect] Aborted old priority sender task");
        }
        if let Some(h) = control_handler_handle.take() {
            h.abort();
            log_info!("[Reconnect] Aborted old control handler task");
        }
        
        // 屏幕尺寸：进程内只取一次（缓存），用 GetSystemMetrics 获取——**不创建 DXGI 设备**。
        // 旧实现每次重连都创建+销毁 DXGI Capturer：1) 驱动层残留线程，每次重连 +15 且不释放；
        // 2) 桌面会话不活跃（锁屏/注销）时 DXGI 设备创建会阻塞，导致 agent 卡死无法连接。
        // GetSystemMetrics 立即返回、绝不阻塞，彻底规避这两个问题。
        let (screen_w, screen_h) = {
            // 只锁一次：先把缓存值复制出来，guard 立即释放（`if let *lock` 的临时 guard
            // 生命周期会覆盖整个 if-let 表达式含 else 分支，若在 else 里再 lock 同一
            // Mutex 会重入死锁——std Mutex 不可重入，首次初始化时必死锁，导致 agent 卡死无法连接）
            let cached = *lock_state!(SCREEN_SIZE);
            if let Some((w, h)) = cached {
                (w, h)
            } else {
                #[cfg(windows)]
                let size = {
                    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
                    let w = unsafe { GetSystemMetrics(SM_CXSCREEN) } as usize;
                    let h = unsafe { GetSystemMetrics(SM_CYSCREEN) } as usize;
                    if w > 0 && h > 0 { Some((w, h)) } else { None }
                };
                #[cfg(not(windows))]
                let size = None;
                match size {
                    Some(s) => {
                        // 此处再 lock 是安全的：上面的 guard 已随 `let cached` 语句结束而释放
                        *lock_state!(SCREEN_SIZE) = Some(s);
                        s
                    }
                    None => {
                        log_warn!("[Agent] WARNING: cannot get screen size, will retry in {}s", retry_delay);
                        retry_delay = (retry_delay * 2).min(RETRY_MAX);
                        continue;
                    }
                }
            }
        };
        let grid_size = 64;
        let screen_res = (screen_w, screen_h);
        let half_w = screen_w / 2;
        let half_h = screen_h / 2;

        // 视频线程的截图器/错误计数（真正的截屏资源在 resume 时惰性创建）
        let mut capturer: Option<ScreenCapturer> = None;
        let mut dxgi_error_count: u32 = 0;
        
        // 大对象惰性初始化：仅在需要截图时创建，空闲时释放
        let mut grid_mgr: Option<GridManager> = None;
        let mut compressor: Option<Compressor> = None;
        let mut quality_engine: Option<QualityEngine> = None;
        let mut frame_buffer: Option<Vec<u8>> = None;
        let mut block_buffer: Option<Vec<u8>> = None;
        let mut downsample_buffer: Option<Vec<u8>> = None;
        
        let mut send_history: VecDeque<(std::time::Instant, usize)> = VecDeque::new();
        let mut status_log_timer = std::time::Instant::now();
        let mut first_frame = true;

        // 视频线程生命周期：独立退出信号 + JoinHandle，重连前 join 旧线程，避免线程泄漏
        let video_shutdown = Arc::new(AtomicBool::new(false));
        let mut video_handle: Option<std::thread::JoinHandle<()>> = None;

        CONNECTED.store(false, Ordering::Relaxed);

        if retry_delay > 1 {
            log_warn!("[Reconnect] Waiting {}s before retry...", retry_delay);
        }
        // 可中断等待：每秒检查 SHUTDOWN 标志，外部请求关闭时立即退出重连循环
        for _ in 0..retry_delay {
            if SHUTDOWN.load(Ordering::Relaxed) {
                log_info!("[Agent] Shutdown requested, exiting reconnect loop");
                break 'reconnect;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        // 每次连接前基于最新 server_url 重建 URL（支持 UDP 发现后地址自动更新）
        let url = format!("{}/agent/register?device_id={}&device_name={}&os={}&cpu={}&ram={}GB&mac={}",
            server_url.trim_end_matches('/'), device_id, host_name_encoded, os_name_encoded, cpu_brand_encoded, mem_gb, mac_encoded);
        log_info!("Connecting to hub at {}", url);
        // 连接加 5s 超时：旧地址失效时立即暴露失败，尽早触发广播发现
        let connect_result = tokio::time::timeout(
            std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
            tokio_tungstenite::connect_async(url.clone()),
        ).await;
        let (ws_stream, _) = match connect_result {
            Ok(Ok(s)) => { retry_delay = 2; fail_count = 0; s } // 连接成功后重置为最小延迟
            Ok(Err(e)) => {
                log_warn!("[Reconnect] Connection failed: {}, next retry in {}s", e, (retry_delay * 2).min(RETRY_MAX));
                handle_connect_failure(&mut retry_delay, &mut fail_count, &mut server_url).await;
                continue;
            }
            Err(_elapsed) => {
                log_warn!("[Reconnect] Connection timeout after {}s, next retry in {}s", CONNECT_TIMEOUT_SECS, (retry_delay * 2).min(RETRY_MAX));
                handle_connect_failure(&mut retry_delay, &mut fail_count, &mut server_url).await;
                continue;
            }
        };
    // TCP_NODELAY: 禁用 Nagle 算法，降低网络延迟（ws:// 连接为 Plain TcpStream）
    use tokio_tungstenite::MaybeTlsStream;
    if let MaybeTlsStream::Plain(tcp) = ws_stream.get_ref() {
        let _ = tcp.set_nodelay(true);
    }
    let (mut write, mut read) = ws_stream.split();
    CONNECTED.store(true, Ordering::Relaxed);
    // 初始化 Pong 时间为当前时间，避免刚连接就因心跳超时检测误判断开
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    LAST_PONG_TIME.store(now_secs, Ordering::Relaxed);

    // === 优先级队列：高优(视频+控制) + 低优(文件传输) ===
    // 高优通道：视频帧、控制响应、ACK 等（永远优先发送）
    let (high_tx, mut high_rx) = tokio::sync::mpsc::channel::<Message>(4096);
    let ack_tx = high_tx.clone(); // 控制命令响应走高优
    let tx = high_tx.clone(); // 视频帧发送也走高优

    // 低优通道：文件传输数据块（仅当高优队列为空时才发送）
    let (low_tx, mut low_rx) = tokio::sync::mpsc::channel::<Message>(4096);
    let file_tx = low_tx.clone(); // 文件传输数据走低优

    // === 终端事件转发：std::sync::mpsc → 高优 WS 通道（与视频帧同一发送路径）===
    // 终端会话的读线程/等待线程通过 TERM_EVENT_TX 发送事件，这里用独立 OS 线程
    // 阻塞 recv 并序列化成 JSON 文本，经 high_tx 走高优通道发送。
    let (term_tx, term_rx) = std::sync::mpsc::channel::<terminal::TerminalEvent>();
    *lock_state!(TERM_EVENT_TX) = Some(term_tx);
    let term_forward_tx = high_tx.clone();
    std::thread::spawn(move || {
        while let Ok(ev) = term_rx.recv() {
            let json = match ev {
                terminal::TerminalEvent::Output { id, data } => {
                    let data_json = serde_json::to_string(&data).unwrap_or_else(|_| "\"\"".to_string());
                    format!(r#"{{"type":"terminal_output","id":{},"data":{}}}"#, id, data_json)
                }
                terminal::TerminalEvent::Closed { id, exit_code } => {
                    let code = exit_code.map(|c| c.to_string()).unwrap_or_else(|| "null".to_string());
                    format!(r#"{{"type":"terminal_closed","id":{},"exit_code":{}}}"#, id, code)
                }
            };
            match term_forward_tx.try_send(Message::Text(json)) {
                // 连接已断开：转发线程退出（所有 sender 掉落时 recv 也会返回 Err）
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                _ => {} // 瞬时队列满：事件丢弃（与视频帧策略一致）
            }
        }
        log_info!("[Terminal] event forwarder exited");
    });

    // 优先级发送任务：永远优先处理高优队列
    // 优先级发送任务：永远优先处理高优队列 + 20s 心跳 ping（防止 Hub 60s 读取超时断开）
    priority_sender_handle = Some(tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(20));
        heartbeat.tick().await; // 跳过第一次立即触发
        loop {
            if let Ok(msg) = high_rx.try_recv() {
                if write.send(msg).await.is_err() {
                    break;
                }
                continue;
            }
            tokio::select! {
                Some(msg) = high_rx.recv() => {
                    if write.send(msg).await.is_err() {
                        break;
                    }
                }
                Some(msg) = low_rx.recv() => {
                    if write.send(msg).await.is_err() {
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    // 发送 WebSocket Ping，保持连接活跃
                    if write.send(Message::Ping(vec![1])).await.is_err() {
                        break;
                    }
                    // Pong 超时检测：距上次收到 Pong 超过 75 秒则认为连接已死，break 触发重连
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let last_pong = LAST_PONG_TIME.load(Ordering::Relaxed);
                    if last_pong > 0 && now.saturating_sub(last_pong) > 75 {
                        log_warn!("[Heartbeat] No Pong received for {}s, triggering reconnect", now.saturating_sub(last_pong));
                        break;
                    }
                }
                else => break,
            }
        }
        CONNECTED.store(false, Ordering::Relaxed);
    }));

    // 控制命令处理
    control_handler_handle = Some(tokio::spawn(async move {
        let file_tx = file_tx.clone();
        loop {
            // 30s 读取超时：防止 WebSocket 半开状态下永久等待
            let msg_result = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                read.next()
            ).await;

            let msg = match msg_result {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => {
                    log_warn!("[ControlHandler] WebSocket read error: {}", e);
                    break;  // 真正的读取错误，断开
                }
                Ok(None) => {
                    log_info!("[ControlHandler] WebSocket closed by peer");
                    break;  // 连接关闭
                }
                Err(_elapsed) => {
                    // 超时：空闲状态无消息是正常的，重试读取（不断开）
                    continue;
                }
            };

            match msg {
                Message::Binary(data) => {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_binary_msg(&data, &ack_tx);
                    }));
                    if let Err(e) = result {
                        log_error!("[Agent] handle_binary_msg panic (已恢复): {:?}", e);
                    }
                }
                Message::Text(text) => {
                if let Ok(cmd) = serde_json::from_str::<ControlCmd>(&text) {
                    match cmd.action.as_str() {
                        "mouse_move" => {
                            if let (Some(x), Some(y)) = (cmd.x, cmd.y) {
                                mouse_move_to(x, y);
                            }
                        }
                        "mouse_down" => {
                            match cmd.button.as_deref() {
                                Some("left") => mouse_button(0, true),
                                Some("right") => mouse_button(1, true),
                                Some("middle") => mouse_button(2, true),
                                _ => {}
                            }
                        }
                        "mouse_up" => {
                            match cmd.button.as_deref() {
                                Some("left") => mouse_button(0, false),
                                Some("right") => mouse_button(1, false),
                                Some("middle") => mouse_button(2, false),
                                _ => {}
                            }
                        }
                        "mouse_click" => {
                            if let (Some(x), Some(y)) = (cmd.x, cmd.y) {
                                mouse_move_to(x, y);
                            }
                            let btn = match cmd.button.as_deref() {
                                Some("left") => 0,
                                Some("right") => 1,
                                Some("middle") => 2,
                                _ => 0,
                            };
                            mouse_button(btn, true);
                            mouse_button(btn, false);
                        }
                        "mouse_wheel" => {
                            if let Some(delta) = cmd.y {
                                mouse_scroll_y(delta);
                            }
                        }
                        "key" => {
                            #[derive(Deserialize)]
                            struct KeyCmd { vk: u16, down: bool }
                            if let Ok(kc) = serde_json::from_str::<KeyCmd>(&text) {
                                #[cfg(windows)]
                                send_key(kc.vk, if kc.down { 0 } else { 1 });
                            } else {
                                log_error!("[KEY] parse KeyCmd FAILED from: {}", text);
                            }
                        }
                        "keyboard" => {
                            if let Some(vk) = cmd.x {
                                let action = cmd.y.unwrap_or(0);
                                #[cfg(windows)]
                                send_key(vk as u16, action as u8);
                            } else {
                            }
                        }
                        "key_press" => {
                            if let Some(ref key_str) = cmd.key {
                                if let Some(vk) = text_key_to_vk(key_str) {
                                    #[cfg(windows)]
                                    {
                                        let flags = KEYBD_EVENT_FLAGS(0);
                                        let input = INPUT {
                                            r#type: INPUT_KEYBOARD,
                                            Anonymous: INPUT_0 {
                                                ki: KEYBDINPUT {
                                                    wVk: VIRTUAL_KEY(vk),
                                                    wScan: 0,
                                                    dwFlags: flags,
                                                    time: 0,
                                                    dwExtraInfo: 0,
                                                },
                                            },
                                        };
                                        send_input_raw(&[input]);
                                    }
                                }
                            }
                        }
                        "key_release" => {
                            if let Some(ref key_str) = cmd.key {
                                if let Some(vk) = text_key_to_vk(key_str) {
                                    #[cfg(windows)]
                                    {
                                        let input = INPUT {
                                            r#type: INPUT_KEYBOARD,
                                            Anonymous: INPUT_0 {
                                                ki: KEYBDINPUT {
                                                    wVk: VIRTUAL_KEY(vk),
                                                    wScan: 0,
                                                    dwFlags: KEYEVENTF_KEYUP,
                                                    time: 0,
                                                    dwExtraInfo: 0,
                                                },
                                            },
                                        };
                                        send_input_raw(&[input]);
                                    }
                                }
                            }
                        }
                        "pause" => {
                            CAPTURE_PAUSED.store(true, Ordering::Relaxed);
                            log_info!("Capture paused (no subscribers)");
                        }
                        "resume" => {
                            CAPTURE_PAUSED.store(false, Ordering::Relaxed);
                            // 清除残留的缩略图快照请求，避免下次暂停时误触发
                            SNAPSHOT_REQUESTED.store(false, Ordering::Relaxed);
                            log_info!("Capture resumed (subscriber connected)");
                        }
                        "snapshot" => {
                            // 空闲态一次性缩略图快照：视频线程临时采一帧低质量全帧 JPEG 发给 Hub
                            SNAPSHOT_REQUESTED.store(true, Ordering::Relaxed);
                            log_info!("Snapshot requested (thumbnail)");
                        }
                        "force_key" => {
                            // 前端因解码拥塞丢弃了脏区域帧，请求立即补一帧完整画面
                            FORCE_KEY_REQUESTED.store(true, Ordering::Relaxed);
                        }
                        "quality" => {
                            if let Some(value) = cmd.value {
                                QUALITY_PROFILE.store(value, Ordering::Relaxed);
                                log_info!("Quality profile set to {}", value);
                            }
                        }
                        "file_init" => {
                            // 解析文件传输初始化参数
                            #[derive(Deserialize)]
                            struct FileInitCmd {
                                file_name: String,
                                file_size: u64,
                                target_dir: String,
                                total_chunks: u32,
                                #[serde(default)]
                                overwrite: Option<String>,
                                #[serde(default)]
                                checksum: Option<String>,
                            }
                            if let Ok(fc) = serde_json::from_str::<FileInitCmd>(&text) {
                                let target_dir = fc.target_dir.trim_end_matches('\\').to_string();
                                // Ensure target directory exists
                                if let Err(e) = std::fs::create_dir_all(&target_dir) {
                                    log_error!("Failed to create directory {}: {}", target_dir, e);
                                    continue;
                                }
                                let final_path = format!("{}\\{}", target_dir, fc.file_name);

                                // Sanitize file_name to prevent path traversal
                                if fc.file_name.contains("..") || fc.file_name.contains(':') || fc.file_name.contains('*') 
                                    || fc.file_name.contains('?') || fc.file_name.contains('"') || fc.file_name.contains('<') 
                                    || fc.file_name.contains('>') || fc.file_name.contains('|') {
                                    let _ = ack_tx.try_send(Message::Text(
                                        r#"{"action":"file_error","error":"access_denied"}"#.into()
                                    ));
                                    continue;
                                }
                                let tmp_path = format!("{}.tmp", final_path);

                                // 1.7 空文件（0 字节）处理
                                if fc.file_size == 0 {
                                    // 创建空的 .tmp 文件
                                    if let Err(e) = std::fs::write(&tmp_path, &[]) {
                                        log_error!("Failed to create empty tmp file: {}", e);
                                        let _ = ack_tx.try_send(Message::Text(
                                            r#"{"action":"file_error","error":"write_error"}"#.into()
                                        ));
                                        continue;
                                    }
                                    // 计算空文件的 SHA-256
                                    let mut hasher = Sha256::new();
                                    hasher.update(&[]);
                                    let checksum_hex = format!("{:x}", hasher.finalize());
                                    // 如果提供了校验和且不匹配
                                    if let Some(ref expected) = fc.checksum {
                                        if !expected.is_empty() && checksum_hex != *expected {
                                            let _ = std::fs::remove_file(&tmp_path);
                                            let _ = ack_tx.try_send(Message::Text(
                                                r#"{"action":"file_error","error":"checksum_mismatch"}"#.into()
                                            ));
                                            continue;
                                        }
                                    }
                                    // 重命名 .tmp 到最终文件
                                    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
                                        log_error!("Failed to rename empty tmp file: {}", e);
                                        let _ = std::fs::remove_file(&tmp_path);
                                        continue;
                                    }
                                    let done = format!(
                                        r#"{{"action":"file_done","file_name":"{}","path":"{}","size":0,"checksum":"{}"}}"#,
                                        fc.file_name, final_path.replace('\\', "\\\\"), checksum_hex
                                    );
                                    let _ = ack_tx.try_send(Message::Text(done));
                                    continue;
                                }

                                // 检查最终文件是否已存在
                                if Path::new(&final_path).exists() {
                                    match fc.overwrite.as_deref() {
                                        Some("overwrite") => {
                                            // 允许覆盖，继续
                                        }
                                        Some("rename") => {
                                            // 查找可用名称
                                            let p = Path::new(&final_path);
                                            let parent = p.parent().unwrap_or(Path::new(""));
                                            let filename = p.file_name().and_then(|s| s.to_str()).unwrap_or("unknown_file");
                                            let (stem, ext) = match filename.rfind('.') {
                                                Some(pos) => (&filename[..pos], &filename[pos..]),
                                                None => (filename, ""),
                                            };
                                            // 需要更新 final_path, tmp_path 和 file_name
                                            // 为了简化，直接在外部计算新路径再重新进入逻辑
                                            // 这里内联重命名逻辑
                                            let mut counter: u32 = 1;
                                            loop {
                                                let new_name = format!("{} ({}){}", stem, counter, ext);
                                                let new_final = parent.join(&new_name);
                                                if !new_final.exists() {
                                                    let new_final_str = new_final.to_str().unwrap_or(&new_name).to_string();
                                                    let new_tmp_str = format!("{}.tmp", new_final_str);
                                                    // 使用新名称
                                                    match std::fs::OpenOptions::new()
                                                        .create_new(true).write(true)
                                                        .open(&new_tmp_str)
                                                    {
                                                        Ok(file) => {
                                                            log_info!("Receiving file: {} ({} bytes, {} chunks) [renamed]", new_final_str, fc.file_size, fc.total_chunks);
                                                            let mut ft_lock = lock_state!(FILE_TRANSFER);
                                                            *ft_lock = Some(FileTransfer {
                                                                file,
                                                                file_name: new_name,
                                                                total_chunks: fc.total_chunks,
                                                                received_chunks: 0,
                                                                total_size: fc.file_size,
                                                                tmp_path: new_tmp_str,
                                                                final_path: new_final_str,
                                                                checksum: fc.checksum.unwrap_or_default(),
                                                            });
                                                            let _ = ack_tx.try_send(Message::Text(
                                                                r#"{"action":"file_ready","offset":0}"#.into()
                                                            ));
                                                        }
                                                        Err(e) => {
                                                            log_error!("Failed to create temp file: {}", e);
                                                        }
                                                    }
                                                    break;
                                                }
                                                counter += 1;
                                                if counter > 9999 { break; }
                                            }
                                            continue;
                                        }
                                        _ => {
                                            // null 或 "false": 跳过
                                            let _ = ack_tx.try_send(Message::Text(
                                                r#"{"action":"file_skip","reason":"already_exists"}"#.into()
                                            ));
                                            continue;
                                        }
                                    }
                                }

                                // 检查是否存在 .tmp 文件（断点续传）
                                let resume_offset = if Path::new(&tmp_path).exists() {
                                    match std::fs::metadata(&tmp_path) {
                                        Ok(meta) => meta.len(),
                                        Err(_) => 0,
                                    }
                                } else {
                                    0
                                };

                                // 打开/创建 .tmp 文件
                                let file = if resume_offset > 0 {
                                    // 追加模式（断点续传）
                                    match std::fs::OpenOptions::new().append(true).open(&tmp_path) {
                                        Ok(f) => f,
                                        Err(e) => {
                                            log_error!("Failed to open tmp file for append: {}", e);
                                            continue;
                                        }
                                    }
                                } else {
                                    // 创建新文件
                                    match File::create(&tmp_path) {
                                        Ok(f) => f,
                                        Err(e) => {
                                            log_error!("Failed to create tmp file {}: {}", tmp_path, e);
                                            continue;
                                        }
                                    }
                                };

                                log_info!("Receiving file: {} ({} bytes, {} chunks)", fc.file_name, fc.file_size, fc.total_chunks);
                                let mut ft_lock = lock_state!(FILE_TRANSFER);
                                *ft_lock = Some(FileTransfer {
                                    file,
                                    file_name: fc.file_name,
                                    total_chunks: fc.total_chunks,
                                    received_chunks: 0,
                                    total_size: fc.file_size,
                                    tmp_path,
                                    final_path,
                                    checksum: fc.checksum.unwrap_or_default(),
                                });
                                let reply = format!(r#"{{"action":"file_ready","offset":{}}}"#, resume_offset);
                                let _ = ack_tx.try_send(Message::Text(reply));
                            }
                        }
                        "file_cancel" => {
                            let mut ft = lock_state!(FILE_TRANSFER);
                            if let Some(transfer) = ft.take() {
                                let _ = std::fs::remove_file(&transfer.tmp_path);
                                log_info!("File transfer cancelled: {}", transfer.file_name);
                            }
                        }
                        "create_dir" | "mkdir" => {
                            #[derive(Deserialize)]
                            struct CreateDirCmd { path: String }
                            if let Ok(dc) = serde_json::from_str::<CreateDirCmd>(&text) {
                                match std::fs::metadata(&dc.path) {
                                    Ok(m) if m.is_dir() => {}
                                    Ok(_) => {
                                        let _ = std::fs::remove_file(&dc.path);
                                        if let Err(e) = std::fs::create_dir_all(&dc.path) {
                                            log_error!("Failed to create directory {}: {}", dc.path, e);
                                        }
                                    }
                                    Err(_) => {
                                        if let Err(e) = std::fs::create_dir_all(&dc.path) {
                                            log_error!("Failed to create directory {}: {}", dc.path, e);
                                        }
                                    }
                                }
                            }
                        }
                        "list_dir" | "ls" => {
                            #[derive(Deserialize)]
                            struct ListDirCmd { path: String }
                            if let Ok(dc) = serde_json::from_str::<ListDirCmd>(&text) {
                                send_list_dir(&ack_tx, &dc.path);
                            }
                        }
                        "check_dir" => {
                            // 探测远端目录是否存在（前端上传前用于提示"是否创建目录"）
                            log_info!("[CheckDir] received check_dir cmd: {}", text);
                            #[derive(Deserialize)]
                            struct CheckDirCmd { path: String }
                            if let Ok(cd) = serde_json::from_str::<CheckDirCmd>(&text) {
                                let exists = std::fs::metadata(&cd.path).map(|m| m.is_dir()).unwrap_or(false);
                                let _ = ack_tx.try_send(Message::Text(
                                    serde_json::json!({
                                        "action": "check_dir",
                                        "path": cd.path,
                                        "exists": exists
                                    }).to_string().into()
                                ));
                            }
                        }
                        "delete_file" | "rm" => {
                            #[derive(Deserialize)]
                            struct DeleteFileCmd { path: String }
                            if let Ok(dc) = serde_json::from_str::<DeleteFileCmd>(&text) {
                                let result = if std::fs::metadata(&dc.path).map(|m| m.is_dir()).unwrap_or(false) {
                                    std::fs::remove_dir(&dc.path)
                                } else {
                                    std::fs::remove_file(&dc.path)
                                };
                                match result {
                                    Ok(_) => {
                                        let _ = ack_tx.try_send(Message::Text(
                                            r#"{"action":"delete_file_result","status":"ok"}"#.into()
                                        ));
                                    }
                                    Err(e) => {
                                        let _ = ack_tx.try_send(Message::Text(
                                            format!(r#"{{"action":"delete_file_result","status":"error","error":"{}"}}"#, e)
                                        ));
                                    }
                                }
                            }
                        }
                        "rename" => {
                            #[derive(Deserialize)]
                            struct RenameCmd {
                                path: String,
                                oldname: String,
                                newname: String,
                            }
                            if let Ok(rc) = serde_json::from_str::<RenameCmd>(&text) {
                                let old_full = format!("{}\\{}", rc.path, rc.oldname);
                                let new_full = format!("{}\\{}", rc.path, rc.newname);
                                match std::fs::rename(&old_full, &new_full) {
                                    Ok(_) => {
                                        let _ = ack_tx.try_send(Message::Text(
                                            r#"{"action":"rename_result","success":true}"#.into()
                                        ));
                                        send_list_dir(&ack_tx, &rc.path);
                                    }
                                    Err(e) => {
                                        let _ = ack_tx.try_send(Message::Text(
                                            format!(r#"{{"action":"rename_result","success":false,"error":"{}"}}"#, e)
                                        ));
                                    }
                                }
                            }
                        }
                        "copy" => {
                            #[derive(Deserialize)]
                            struct CopyCmd {
                                scpath: String,
                                dspath: String,
                                names: Vec<String>,
                            }
                            if let Ok(cc) = serde_json::from_str::<CopyCmd>(&text) {
                                let mut success = true;
                                for name in &cc.names {
                                    let src = format!("{}\\{}", cc.scpath, name);
                                    let dst = format!("{}\\{}", cc.dspath, name);
                                    match std::fs::metadata(&src) {
                                        Ok(meta) if meta.is_dir() => {
                                            continue;
                                        }
                                        Ok(_) => {
                                            if let Err(e) = std::fs::copy(&src, &dst) {
                                                log_error!("Failed to copy {}: {}", src, e);
                                                success = false;
                                            }
                                        }
                                        Err(e) => {
                                            log_error!("Failed to access {}: {}", src, e);
                                            success = false;
                                        }
                                    }
                                }
                                if success {
                                    let _ = ack_tx.try_send(Message::Text(
                                        r#"{"action":"copy_result","success":true}"#.into()
                                    ));
                                } else {
                                    let _ = ack_tx.try_send(Message::Text(
                                        r#"{"action":"copy_result","success":false,"error":"some files failed"}"#.into()
                                    ));
                                }
                                send_list_dir(&ack_tx, &cc.dspath);
                            }
                        }
                        "move" => {
                            #[derive(Deserialize)]
                            struct MoveCmd {
                                scpath: String,
                                dspath: String,
                                names: Vec<String>,
                            }
                            if let Ok(mc) = serde_json::from_str::<MoveCmd>(&text) {
                                let mut success = true;
                                for name in &mc.names {
                                    let src = format!("{}\\{}", mc.scpath, name);
                                    let dst = format!("{}\\{}", mc.dspath, name);
                                    let is_dir = std::fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false);
                                    if is_dir {
                                        continue;
                                    }
                                    if std::fs::rename(&src, &dst).is_err() {
                                        match std::fs::copy(&src, &dst) {
                                            Ok(_) => {
                                                if let Err(e) = std::fs::remove_file(&src) {
                                                    log_error!("Failed to remove source {}: {}", src, e);
                                                    success = false;
                                                }
                                            }
                                            Err(e) => {
                                                log_error!("Failed to copy {}: {}", src, e);
                                                success = false;
                                            }
                                        }
                                    }
                                }
                                if success {
                                    let _ = ack_tx.try_send(Message::Text(
                                        r#"{"action":"move_result","success":true}"#.into()
                                    ));
                                } else {
                                    let _ = ack_tx.try_send(Message::Text(
                                        r#"{"action":"move_result","success":false,"error":"some files failed"}"#.into()
                                    ));
                                }
                                send_list_dir(&ack_tx, &mc.scpath);
                                send_list_dir(&ack_tx, &mc.dspath);
                            }
                        }
                        "download" => {
                            #[derive(Deserialize)]
                            struct DownloadCmd {
                                sub: String,
                                path: Option<String>,
                                id: Option<String>,
                                ack: Option<u32>,
                            }
                            if let Ok(dc) = serde_json::from_str::<DownloadCmd>(&text) {
                                match dc.sub.as_str() {
                                    "start" => {
                                        let path = dc.path.unwrap_or_default();
                                        let id = dc.id.unwrap_or_default();
                                        match std::fs::File::open(&path) {
                                            Ok(file) => {
                                                let metadata = match file.metadata() {
                                                    Ok(m) => m,
                                                    Err(e) => {
                                                        let _ = ack_tx.try_send(Message::Text(
                                                            format!(r#"{{"action":"file_error","error":"{}"}}"#, e)
                                                        ));
                                                        continue;
                                                    }
                                                };
                                                let total_size = metadata.len();
                                            let mut ds = lock_state!(DOWNLOAD_STATE);
                                                *ds = Some(DownloadState {
                                                    file,
                                                    path: path.clone(),
                                                    total_size,
                                                    id: id.clone(),
                                                    window_size: 0,
                                                    in_flight: 0,
                                                    offset: 0,
                                                    finished: false,
                                                });
                                                drop(ds);
                                                let reply = format!(
                                                    r#"{{"action":"download","sub":"start","id":"{}","size":{},"proto":2}}"#,
                                                    id, total_size
                                                );
                                                let _ = ack_tx.try_send(Message::Text(reply));
                                            }
                                            Err(e) => {
                                                let _ = ack_tx.try_send(Message::Text(
                                                    format!(r#"{{"action":"file_error","error":"{}"}}"#, e)
                                                ));
                                            }
                                        }
                                    }
                                    "startack" => {
                                        let id = dc.id.unwrap_or_default();
                                        let window_size = dc.ack.unwrap_or(4).min(4);
                                    let mut ds = lock_state!(DOWNLOAD_STATE);
                                        if let Some(ref mut state) = *ds {
                                            if state.id != id {
                                                continue;
                                            }
                                            state.window_size = window_size;
                                            drop(ds);
                                            for _ in 0..window_size {
                                                send_download_chunk(&ack_tx);
                                            }
                                        }
                                    }
                                    "ack" => {
                                        let id = dc.id.unwrap_or_default();
                                    let mut ds = lock_state!(DOWNLOAD_STATE);
                                        if let Some(ref mut state) = *ds {
                                            if state.id != id {
                                                continue;
                                            }
                                            if state.in_flight > 0 {
                                                state.in_flight -= 1;
                                            }
                                            let window_size = state.window_size;
                                            let in_flight = state.in_flight;
                                            let finished = state.finished;
                                            drop(ds);
                                            if !finished && in_flight < window_size {
                                                send_download_chunk(&ack_tx);
                                            }
                                        }
                                    }
                                    "stop" => {
                                        let id = dc.id.unwrap_or_default();
                                    let mut ds = lock_state!(DOWNLOAD_STATE);
                                        if let Some(state) = ds.take() {
                                            if state.id == id {
                                                drop(state);
                                            } else {
                                                *ds = Some(state);
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "file_download" => {
                            #[derive(Deserialize)]
                            struct FileDownloadCmd { path: String }
                            if let Ok(dc) = serde_json::from_str::<FileDownloadCmd>(&text) {
                                let path = dc.path.clone();
                                let ack = ack_tx.clone();
                                let file = file_tx.clone();
                                std::thread::spawn(move || {
                                    // 流式读取（而非整文件读入内存），大文件下内存保持恒定
                                    let mut file_handle = match std::fs::File::open(&path) {
                                        Ok(f) => f,
                                        Err(e) => {
                                            let _ = ack.try_send(Message::Text(
                                                format!(r#"{{"action":"file_error","error":"{}"}}"#, e)
                                            ));
                                            return;
                                        }
                                    };
                                    let total_size = match file_handle.metadata() {
                                        Ok(m) => m.len(),
                                        Err(e) => {
                                            let _ = ack.try_send(Message::Text(
                                                format!(r#"{{"action":"file_error","error":"{}"}}"#, e)
                                            ));
                                            return;
                                        }
                                    };
                                    let chunk_size: usize = 64 * 1024;
                                    // 协议用 u16 存块索引/总数（最大 65535 块 ≈4GB），超出则拒绝，避免索引回绕损坏文件
                                    let max_chunks: u64 = 65535;
                                    let total_chunks = total_size.div_ceil(chunk_size as u64);
                                    if total_chunks > max_chunks {
                                        let _ = ack.try_send(Message::Text(
                                            r#"{"action":"file_error","error":"file_too_large"}"#.into()
                                        ));
                                        return;
                                    }

                                    // Send ready
                                    let _ = ack.try_send(Message::Text(
                                        format!(r#"{{"action":"file_download_ready","size":{},"total_chunks":{}}}"#,
                                            total_size, total_chunks)
                                    ));

                                    // Send chunks（每块 64KB 一读一发，内存不随文件大小增长）
                                    let mut buf = vec![0u8; chunk_size];
                                    let mut i: u64 = 0;
                                    loop {
                                        // 连接断开时提前退出，释放句柄
                                        if !CONNECTED.load(std::sync::atomic::Ordering::Relaxed) {
                                            return;
                                        }
                                        let n = match file_handle.read(&mut buf) {
                                            Ok(0) => break, // EOF
                                            Ok(n) => n,
                                            Err(_) => {
                                                let _ = ack.try_send(Message::Text(
                                                    r#"{"action":"file_error","error":"read_failed"}"#.into()
                                                ));
                                                return;
                                            }
                                        };
                                        let mut packet = Vec::with_capacity(5 + n);
                                        packet.push(0x08); // file download chunk type
                                        packet.push(((i >> 8) & 0xFF) as u8);
                                        packet.push((i & 0xFF) as u8);
                                        packet.push(((total_chunks >> 8) & 0xFF) as u8);
                                        packet.push((total_chunks & 0xFF) as u8);
                                        packet.extend_from_slice(&buf[..n]);

                                        if file.try_send(Message::Binary(packet)).is_err() {
                                            return;
                                        }
                                        i += 1;
                                        // Small delay to avoid flooding
                                        std::thread::sleep(std::time::Duration::from_millis(1));
                                    }

                                    // Send done
                                    let _ = ack.try_send(Message::Text(
                                        r#"{"action":"file_download_done"}"#.into()
                                    ));
                                });
                            }
                        }
                        "upload" => {
                            log_info!("[Upload] received upload cmd: {}", text);
                            #[derive(Deserialize)]
                            struct UploadCmd {
                                sub: Option<String>,
                                path: Option<String>,
                                name: Option<String>,
                                size: Option<u64>,
                                overwrite: Option<String>,
                            }
                            if let Ok(uc) = serde_json::from_str::<UploadCmd>(&text) {
                                log_info!("[Upload] parsed ok, sub={:?}", uc.sub);
                                match uc.sub.as_deref() {
                                    Some("start") => {
                                        let path = uc.path.unwrap_or_default();
                                        let name = uc.name.unwrap_or_default();
                                        let size = uc.size.unwrap_or(0);
                                        let mut full_path = if path.is_empty() {
                                            name.clone()
                                        } else {
                                            format!("{}\\{}", path, name)
                                        };
                                        if !path.is_empty() {
                                            match std::fs::metadata(&path) {
                                                Ok(m) if m.is_dir() => {}
                                                Ok(_) => {
                                                    let _ = std::fs::remove_file(&path);
                                                    if let Err(e) = std::fs::create_dir_all(&path) {
                                                        log_error!("Failed to create directory {}: {}", path, e);
                                                        let _ = ack_tx.try_send(Message::Text(
                                                            r#"{"action":"upload","sub":"error"}"#.into()
                                                        ));
                                                        continue;
                                                    }
                                                }
                                                Err(_) => {
                                                    if let Err(e) = std::fs::create_dir_all(&path) {
                                                        log_error!("Failed to create directory {}: {}", path, e);
                                                        let _ = ack_tx.try_send(Message::Text(
                                                            r#"{"action":"upload","sub":"error"}"#.into()
                                                        ));
                                                        continue;
                                                    }
                                                }
                                            }
                                        }
                                        // 同名文件冲突处理：skip 跳过 / rename 自动重命名 / 其他（含缺省）覆盖
                                        if Path::new(&full_path).exists() {
                                            match uc.overwrite.as_deref() {
                                                Some("skip") => {
                                                    let msg = serde_json::json!({
                                                        "action": "upload",
                                                        "sub": "error",
                                                        "error": format!("file_exists (skip): {}", name)
                                                    })
                                                    .to_string();
                                                    let _ = ack_tx.try_send(Message::Text(msg.into()));
                                                    log_info!("[Upload] file exists, skip: {}", full_path);
                                                    continue;
                                                }
                                                Some("rename") => {
                                                    let stem = Path::new(&name)
                                                        .file_stem()
                                                        .map(|s| s.to_string_lossy().to_string())
                                                        .unwrap_or_else(|| name.clone());
                                                    let ext = Path::new(&name)
                                                        .extension()
                                                        .map(|s| format!(".{}", s.to_string_lossy()))
                                                        .unwrap_or_default();
                                                    let mut i = 1;
                                                    loop {
                                                        let new_name = format!("{} ({}){}", stem, i, ext);
                                                        let candidate = if path.is_empty() {
                                                            new_name
                                                        } else {
                                                            format!("{}\\{}", path, new_name)
                                                        };
                                                        if !Path::new(&candidate).exists() {
                                                            full_path = candidate;
                                                            break;
                                                        }
                                                        i += 1;
                                                    }
                                                    log_info!("[Upload] file exists, rename to: {}", full_path);
                                                }
                                                _ => {}
                                            }
                                        }
                                        match std::fs::File::create(&full_path) {
                                            Ok(file) => {
                                                let mut us = lock_state!(UPLOAD_STATE_V2);
                                                *us = Some(UploadStateV2 {
                                                    file,
                                                    path: path.clone(),
                                                    name: name.clone(),
                                                    total_size: size,
                                                    received_size: 0,
                                                    done: false,
                                                });
                                                drop(us);
                                                let _ = ack_tx.try_send(Message::Text(
                                                    r#"{"action":"upload","sub":"start"}"#.into()
                                                ));
                                            }
                                            Err(e) => {
                                                log_error!("Failed to create file {}: {}", full_path, e);
                                                let _ = ack_tx.try_send(Message::Text(
                                                    r#"{"action":"upload","sub":"error"}"#.into()
                                                ));
                                            }
                                        }
                                    }
                                    Some("done") => {
                                        let path_opt = {
                                            let mut us = lock_state!(UPLOAD_STATE_V2);
                                            us.take().map(|state| state.path.clone())
                                        };
                                        if let Some(path) = path_opt {
                                            let _ = ack_tx.try_send(Message::Text(
                                                r#"{"action":"upload","sub":"done"}"#.into()
                                            ));
                                            send_list_dir(&ack_tx, &path);
                                        }
                                    }
                                    Some("cancel") => {
                                        let mut us = lock_state!(UPLOAD_STATE_V2);
                                        if let Some(state) = us.take() {
                                            let full_path = if state.path.is_empty() {
                                                state.name.clone()
                                            } else {
                                                format!("{}\\{}", state.path, state.name)
                                            };
                                            drop(state);
                                            let _ = std::fs::remove_file(&full_path);
                                            drop(us);
                                            let _ = ack_tx.try_send(Message::Text(
                                                r#"{"action":"upload","sub":"cancel"}"#.into()
                                            ));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "terminal_open" => {
                            if let Some(id) = cmd.id {
                                let out_tx = match lock_state!(TERM_EVENT_TX).clone() {
                                    Some(tx) => tx,
                                    None => {
                                        let _ = ack_tx.try_send(Message::Text(
                                            format!(r#"{{"type":"terminal_opened","id":{},"success":false,"pid":null,"error":"no terminal channel"}}"#, id)
                                        ));
                                        continue;
                                    }
                                };
                                let rows = cmd.rows.unwrap_or(30);
                                let cols = cmd.cols.unwrap_or(100);
                                match terminal::spawn_session(id, rows, cols, out_tx) {
                                    Ok(pid) => {
                                        log_info!("[Terminal] session {} opened (pid={})", id, pid);
                                        let _ = ack_tx.try_send(Message::Text(
                                            format!(r#"{{"type":"terminal_opened","id":{},"success":true,"pid":{},"error":null}}"#, id, pid)
                                        ));
                                    }
                                    Err(e) => {
                                        log_error!("[Terminal] open session {} failed: {}", id, e);
                                        let err_json = serde_json::to_string(&e).unwrap_or_else(|_| "\"unknown\"".to_string());
                                        let _ = ack_tx.try_send(Message::Text(
                                            format!(r#"{{"type":"terminal_opened","id":{},"success":false,"pid":null,"error":{}}}"#, id, err_json)
                                        ));
                                    }
                                }
                            }
                        }
                        "terminal_input" => {
                            if let (Some(id), Some(data)) = (cmd.id, cmd.data.as_ref()) {
                                if !terminal::write_input(id, data) {
                                    log_warn!("[Terminal] write_input failed for session {}", id);
                                }
                            }
                        }
                        "terminal_resize" => {
                            if let Some(id) = cmd.id {
                                let rows = cmd.rows.unwrap_or(30);
                                let cols = cmd.cols.unwrap_or(100);
                                terminal::resize_session(id, rows, cols);
                            }
                        }
                        "terminal_close" => {
                            if let Some(id) = cmd.id {
                                if let Some(exit_code) = terminal::close_session(id) {
                                    let _ = ack_tx.try_send(Message::Text(
                                        format!(r#"{{"type":"terminal_closed","id":{},"exit_code":{}}}"#, id, exit_code)
                                    ));
                                }
                                // close_session 返回 None：会话已自行退出，Closed 事件由转发线程上报
                            }
                        }
                        // 快速诊断：立即返回 pong 以测试通信回路
                        "ping_system" => {
                            let now_secs = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();
                            let reply = serde_json::json!({
                                "action": "ping_system",
                                "success": true,
                                "data": { "pong": true, "timestamp": now_secs }
                            }).to_string();
                            let _ = ack_tx.send(Message::Text(reply)).await;
                        }
                        #[cfg(windows)]
                        "get_ip_config" => {
                            // 执行 ipconfig /all：不切换代码页，保持 cmd 默认 OEM 代码页输出，
                            // 解码时按 chcp 探测的实际代码页选择编码（见 decode_console_output）
                            let output = tokio::task::spawn_blocking(move || {
                                std::process::Command::new("cmd")
                                    .args(["/C", "ipconfig /all"])
                                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                    .output()
                            }).await.ok().and_then(|r| r.ok());
                            
                            let (stdout_text, stderr_text) = match output {
                                Some(out) => {
                                    // 按当前 OEM 代码页解码（中文 GBK / 日文 cp932 / 韩文 cp949 / 英文 1252）
                                    let stdout_decoded = decode_console_output(&out.stdout);
                                    let stderr_clean = String::from_utf8_lossy(&out.stderr).to_string();
                                    (stdout_decoded, stderr_clean)
                                }
                                None => (String::new(), String::new()),
                            };
                            
                            // 解析：按接口分段提取字段
                            let mut interfaces: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
                            let lines: Vec<&str> = stdout_text.lines().collect();
                            let mut current_interface: Option<&mut serde_json::Map<String, serde_json::Value>> = None;
                            
                            // 打印原始输出（前 3000 字符）用于调试
                            // 按字符截断，按字节切会在中文/UTF-8 边界 panic
                            let raw_preview: String = stdout_text.chars().take(3000).collect();
                            log_info!("[get_ip_config] Raw output (first 3000 chars):\n{}", raw_preview);
                            
                            // 虚拟网卡关键词列表（小写）。
                            // 注意：不包含 "adapter" 等过宽词——名称形如 "Intel(R) Ethernet Adapter I219-V" 的
                            // 真实物理网卡会被误杀；同时补充现代 VPN 虚拟网卡（tailscale/zerotier/warp 等）
                            let virtual_keywords = [
                                "tap", "tun", "vpn", "virtual", "loopback", "bluetooth",
                                "vmware", "virtualbox", "hyper-v", "vethernet", "isatap",
                                "teredo", "wwan", "wgcf", "wg", "openvpn", "tunnel",
                                "heidi", "oc-helper", "netease",
                                "tailscale", "zerotier", "warp", "wintun", "nordvpn", "expressvpn"
                            ];
                            
                            // DNS 续行状态：第二个及后续 DNS 服务器是独立行（不含 "DNS" 关键字）
                            let mut dns_block_active = false;
                            // 默认网关续行状态：多网关场景下第二个网关是缩进的纯 IP 独立行
                            let mut gateway_block_active = false;
                            for line in lines.iter() {
                                let line_trimmed = line.trim();
                                
                                // 检测适配器标题行
                                if line_trimmed.contains("adapter ") || line_trimmed.contains("适配器 ") {
                                    dns_block_active = false;
                                    gateway_block_active = false;
                                    // 提取适配器名称
                                    let adapter_name = if line_trimmed.contains("adapter ") {
                                        let after = &line_trimmed[line_trimmed.find("adapter ").unwrap() + "adapter ".len()..];
                                        after.trim_end_matches(|c| c == ':' || c == '：').to_string()
                                    } else if line_trimmed.contains("适配器 ") {
                                        let after = &line_trimmed[line_trimmed.find("适配器 ").unwrap() + "适配器 ".len()..];
                                        after.trim_end_matches(|c| c == ':' || c == '：').to_string()
                                    } else {
                                        line_trimmed.replace(|c| c == ':' || c == '：', "").trim().to_string()
                                    };
                                    
                                    // 过滤虚拟网卡
                                    let lower_name = adapter_name.to_lowercase();
                                    let is_virtual = virtual_keywords.iter().any(|k| lower_name.contains(k));
                                    
                                    if is_virtual {
                                        current_interface = None;
                                        continue;
                                    }
                                    
                                    let mut map = serde_json::Map::new();
                                    map.insert("name".to_string(), serde_json::Value::String(adapter_name.clone()));
                                    interfaces.push(map);
                                    current_interface = interfaces.last_mut();
                                    continue;
                                }
                                
                                // 在已有接口中补充字段
                                if let Some(ref mut last) = current_interface {
                                    // IPv4 地址 - 匹配 "IPv4 地址" 或 "IPv4 Address"
                                    if line_trimmed.contains("IPv4") {
                                        if let Some(val) = extract_after_colon(line_trimmed) {
                                            // 清理值：去掉括号内容，只取第一个 token
                                            let cleaned: String = val
                                                .split(|c: char| c == '(' || c == '（')
                                                .next()
                                                .unwrap_or(&val)
                                                .trim()
                                                .split_whitespace()
                                                .next()
                                                .unwrap_or("")
                                                .to_string();
                                            if !cleaned.is_empty() && !cleaned.contains(':') && cleaned.contains('.') {
                                                last.insert("ipv4".to_string(), serde_json::Value::String(cleaned));
                                            }
                                        }
                                    }
                                    // 子网掩码
                                    else if line_trimmed.contains("Subnet") || line_trimmed.contains("掩码") {
                                        if let Some(val) = extract_after_colon(line_trimmed) {
                                            let cleaned = val.trim().split_whitespace().next().unwrap_or("").to_string();
                                            if !cleaned.is_empty() && cleaned.contains('.') {
                                                last.insert("mask".to_string(), serde_json::Value::String(cleaned));
                                            }
                                        }
                                    }
                                    // 默认网关
                                    else if line_trimmed.contains("Gateway") || line_trimmed.contains("网关") {
                                        if let Some(val) = extract_after_colon(line_trimmed) {
                                            let cleaned = val.trim().split_whitespace().next().unwrap_or("").to_string();
                                            if !cleaned.is_empty() && cleaned.contains('.') {
                                                last.insert("gateway".to_string(), serde_json::Value::String(cleaned));
                                                gateway_block_active = true;
                                            } else {
                                                // 值非 IPv4（如 "IPv6 默认网关" 的 fe80::...）：视为网关段结束
                                                gateway_block_active = false;
                                            }
                                        } else {
                                            gateway_block_active = false;
                                        }
                                    }
                                    // 默认网关续行：多网关场景下第二个及后续网关是缩进的纯 IPv4 独立行
                                    else if gateway_block_active && line_trimmed.parse::<std::net::Ipv4Addr>().is_ok() {
                                        let mut cur = match last.get("gateway").and_then(|v| v.as_str()) {
                                            Some(s) => s.to_string(),
                                            None => String::new(),
                                        };
                                        if !cur.is_empty() {
                                            cur.push_str(", ");
                                        }
                                        cur.push_str(line_trimmed);
                                        last.insert("gateway".to_string(), serde_json::Value::String(cur));
                                        log_info!("[get_ip_config] Gateway continuation appended: '{}'", line_trimmed);
                                    }
                                    // 其他带标签行（含冒号）到来：默认网关段结束
                                    else if gateway_block_active && line_trimmed.contains(':') {
                                        gateway_block_active = false;
                                    }
                                    // DNS 服务器 - 可能是多行，仅提取 IPv4 地址。
                                    // 首行仅匹配 "DNS Servers"/"DNS 服务器" 标签，避免 "DNS Suffix" 等 DNS 后缀类行误匹配
                                    else if (line_trimmed.contains("DNS Servers") || line_trimmed.contains("DNS 服务器"))
                                        && !line_trimmed.contains("DUID")
                                    {
                                        log_info!("[get_ip_config] Matching DNS line: '{}'", line_trimmed);
                                        if let Some(val) = extract_after_colon(line_trimmed) {
                                            log_info!("[get_ip_config] DNS raw value: '{}'", val);
                                            // 清理值：按空白分割，收集所有 IPv4 地址（IPv6 token 不收集）
                                            let ipv4_dns: Vec<&str> = val
                                                .split_whitespace()
                                                .filter(|s| s.contains('.') && !s.contains(':'))
                                                .collect();
                                            
                                            if !ipv4_dns.is_empty() {
                                                let dns_str = ipv4_dns.join(", ");
                                                log_info!("[get_ip_config] DNS inserted: '{}'", &dns_str);
                                                last.insert("dns".to_string(), serde_json::Value::String(dns_str));
                                            }
                                            // 只要冒号后非空值（含纯 IPv6 首行如 "fe80::1%8"）即保持续行采集激活，
                                            // 保证后续独立续行（IPv4 DNS，如 223.5.5.5 / 223.6.6.6）仍会被收集
                                            dns_block_active = true;
                                        } else {
                                            log_warn!("[get_ip_config] extract_after_colon returned None for DNS line");
                                        }
                                    }
                                    // DNS 续行：第二个及后续 DNS 服务器是独立行（纯 IPv4，无标签冒号）。
                                    // 用 Ipv4Addr 解析严格校验，避免把网关续行/其他纯 IP 样式的行误收为 DNS
                                    else if dns_block_active && line_trimmed.parse::<std::net::Ipv4Addr>().is_ok()
                                    {
                                        // 首行若为 IPv6（dns 字段尚未建立），当前续行作为首个 IPv4 DNS 创建字段
                                        let mut cur = match last.get("dns").and_then(|v| v.as_str()) {
                                            Some(s) => s.to_string(),
                                            None => String::new(),
                                        };
                                        if !cur.is_empty() {
                                            cur.push_str(", ");
                                        }
                                        cur.push_str(line_trimmed);
                                        last.insert("dns".to_string(), serde_json::Value::String(cur));
                                        log_info!("[get_ip_config] DNS continuation appended: '{}'", line_trimmed);
                                    }
                                    // DNS 续行：IPv6 地址续行（可直接解析 Ipv6Addr，或含 % zone-id 的纯十六进制串，
                                    // 如 "fe80::1%8"）。保持采集激活但不追加，避免被下方带冒号分支误判为段结束而重置
                                    else if dns_block_active
                                        && !line_trimmed.contains(' ')
                                        && is_ipv6_like_token(&line_trimmed)
                                    {
                                        log_info!("[get_ip_config] DNS IPv6 continuation skipped (block kept): '{}'", line_trimmed);
                                    }
                                    // 其他带标签行（含冒号）到来：DNS 段结束
                                    else if dns_block_active && line_trimmed.contains(':') {
                                        dns_block_active = false;
                                    }
                                    // 物理地址（MAC）
                                    else if line_trimmed.contains("Physical") || (line_trimmed.contains("地址") && !line_trimmed.contains("IPv") && !line_trimmed.contains("DNS")) {
                                        if let Some(val) = extract_after_colon(line_trimmed) {
                                            let cleaned = val.trim();
                                            if !cleaned.is_empty() && cleaned.len() >= 8 && cleaned.len() <= 17 {
                                                // 验证 MAC 格式（包含冒号或连字符）
                                                if cleaned.contains(':') || cleaned.contains('-') {
                                                    last.insert("mac".to_string(), serde_json::Value::String(cleaned.to_string()));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            
                            let reply = serde_json::json!({
                                "action": "get_ip_config",
                                "success": true,
                                "data": {
                                    "interfaces": interfaces,
                                    "interface_count": interfaces.len(),
                                    "raw_text_length": stdout_text.len(),
                                    "stderr": stderr_text
                                }
                            }).to_string();
                            log_info!("[get_ip_config] Response: interfaces={:?}, raw_len={}", interfaces.len(), stdout_text.len());
                            let _ = ack_tx.send(Message::Text(reply)).await;
                        }
                        #[cfg(windows)]
                        "check_ip_usage" => {
                            let ip_to_check = cmd.ip.as_deref().unwrap_or("");
                            if ip_to_check.is_empty() {
                                let reply = serde_json::json!({
                                    "action": "check_ip_usage",
                                    "success": false,
                                    "error": "缺少 ip 字段"
                                }).to_string();
                                let _ = ack_tx.send(Message::Text(reply)).await;
                            } else {
                                // 方法1: ping 检测（单个包，500ms 超时）+ 方法2: ARP 表检测
                                // 都在 spawn_blocking 中执行，避免阻塞 tokio worker 线程（worker_threads=2）
                                let ip_to_check_owned = ip_to_check.to_string();
                                let (ping_in_use, arp_found) = tokio::task::spawn_blocking(move || {
                                    let ping_result = std::process::Command::new("ping")
                                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                        .args(["-n", "1", "-w", "500", &ip_to_check_owned])
                                        .output();
                                    let ping_ok = match ping_result {
                                        Ok(out) => {
                                            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
                                            // 中文系统 "TTL=" 英文系统 "ttl=" 前缀是响应标志；超时目标不可达则无 TTL
                                            text.contains("ttl=") || text.contains("ttl  ")
                                        }
                                        Err(_) => false,
                                    };
                                    // ARP 表：看该 IP 是否已有缓存条目
                                    let arp_result = std::process::Command::new("arp")
                                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                        .args(["-a", &ip_to_check_owned])
                                        .output();
                                    let arp_found = match arp_result {
                                        Ok(out) => {
                                            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
                                            text.contains(&ip_to_check_owned.to_lowercase()) && !text.contains("no entries")
                                        }
                                        Err(_) => false,
                                    };
                                    (ping_ok, arp_found)
                                }).await.unwrap_or((false, false));
                                let in_use = ping_in_use || arp_found;
                                let reply = serde_json::json!({
                                    "action": "check_ip_usage",
                                    "success": true,
                                    "data": {
                                        "ip": ip_to_check,
                                        "in_use": in_use,
                                        "ping_responded": ping_in_use,
                                        "arp_found": arp_found,
                                        "message": if in_use {
                                            format!("IP {} 已被使用（可能存在冲突风险）", ip_to_check)
                                        } else {
                                            format!("IP {} 未被检测到使用中", ip_to_check)
                                        }
                                    }
                                }).to_string();
                                let _ = ack_tx.send(Message::Text(reply)).await;
                            }
                        }
                        #[cfg(windows)]
                        "rename_computer" => {
                            if let Some(name) = cmd.name.as_ref() {
                                // CreateProcess 直启 wmic 不经 cmd，%computername% 不会被展开，
                                // 必须从环境变量读取真实主机名拼进 WQL where 子句
                                let comp_name = std::env::var("COMPUTERNAME")
                                    .or_else(|_| std::env::var("HOSTNAME"))
                                    .unwrap_or_default();
                                let output = tokio::task::spawn_blocking({
                                    let comp_name = comp_name.clone();
                                    let name = name.clone();
                                    move || {
                                        std::process::Command::new("wmic")
                                            .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                            .args(["computersystem", "where",
                                                &format!("name=\"{}\"", comp_name),
                                                "call", "rename", &name])
                                            .output()
                                    }
                                }).await.ok().and_then(|r| r.ok());
                                match output {
                                    Some(out) if out.status.success() => {
                                        // wmic 无匹配实例时退出码仍为 0：检查 stdout 防止静默误报成功
                                        let so = String::from_utf8_lossy(&out.stdout).to_lowercase();
                                        if comp_name.is_empty() || so.contains("no instance") || so.contains("没有可用实例") {
                                            let reply = serde_json::json!({
                                                "action": "rename_computer",
                                                "success": false,
                                                "error": "未找到匹配的计算机实例"
                                            }).to_string();
                                            let _ = ack_tx.send(Message::Text(reply)).await;
                                        } else {
                                            let reply = serde_json::json!({
                                                "action": "rename_computer",
                                                "success": true,
                                                "message": "重启后生效"
                                            }).to_string();
                                            let _ = ack_tx.send(Message::Text(reply)).await;
                                        }
                                    }
                                    Some(out) => {
                                        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                                        let reply = serde_json::json!({
                                            "action": "rename_computer",
                                            "success": false,
                                            "error": stderr
                                        }).to_string();
                                        let _ = ack_tx.send(Message::Text(reply)).await;
                                    }
                                    None => {
                                        let reply = serde_json::json!({
                                            "action": "rename_computer",
                                            "success": false,
                                            "error": "wmic 执行失败"
                                        }).to_string();
                                        let _ = ack_tx.send(Message::Text(reply)).await;
                                    }
                                }
                            } else {
                                let reply = serde_json::json!({
                                    "action": "rename_computer",
                                    "success": false,
                                    "error": "缺少 name 字段"
                                }).to_string();
                                let _ = ack_tx.send(Message::Text(reply)).await;
                            }
                        }
                        #[cfg(windows)]
                        "set_ip" => {
                            let interface = cmd.interface.as_ref();
                            let ip_addr = cmd.ip.as_ref();
                            let mask = cmd.mask.as_ref();
                            let gateway = cmd.gateway.as_ref();
                            let dns_servers = cmd.dns.as_ref();
                            if interface.is_none() || ip_addr.is_none() || mask.is_none() || gateway.is_none() {
                                let reply = serde_json::json!({
                                    "action": "set_ip",
                                    "success": false,
                                    "error": "缺少必要参数：interface、ip、mask、gateway"
                                }).to_string();
                                let _ = ack_tx.try_send(Message::Text(reply));
                            } else {
                                let interface_for_reply = interface.unwrap().to_string();
                                let ip_addr_for_reply = ip_addr.unwrap().to_string();
                                let mask_for_reply = mask.unwrap().to_string();
                                let gateway_for_reply = gateway.unwrap().to_string();
                                // netsh 为同步阻塞调用：放入 spawn_blocking，避免阻塞 tokio worker（worker_threads=2）
                                let iface_b = interface_for_reply.clone();
                                let ip_b = ip_addr_for_reply.clone();
                                let mask_b = mask_for_reply.clone();
                                // 网关字段可能为 "192.168.1.1, 192.168.1.2"（多网关续行拼接），netsh 只接受单个网关，取第一个
                                let gw_b = gateway_for_reply
                                    .split(|c: char| c == ',' || c == '，' || c.is_whitespace())
                                    .next()
                                    .unwrap_or("")
                                    .trim()
                                    .to_string();
                                let dns_b = dns_servers.cloned().unwrap_or_default();
                                let (addr_ok, dns_ok, errors) = tokio::task::spawn_blocking(move || {
                                    let mut errors = Vec::new();
                                    // 第一步：设置静态 IP 地址
                                    let set_addr = std::process::Command::new("netsh")
                                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                        .args(["interface", "ip", "set", "address",
                                            &format!("name={}", iface_b), "static",
                                            &ip_b, &mask_b, &gw_b, "1"])
                                        .output();
                                    let addr_ok = match set_addr {
                                        Ok(out) if out.status.success() => true,
                                        Ok(out) => {
                                            errors.push(format!("set address 失败: {}", String::from_utf8_lossy(&out.stderr)));
                                            false
                                        }
                                        Err(e) => {
                                            errors.push(format!("set address 错误: {}", e));
                                            false
                                        }
                                    };
                                    // 第二步：设置 DNS（如果提供了 dns 字段）
                                    // 首个用 set dns（会清空原有 DNS 列表后设置首选），其余用 add dns 追加为备用
                                    let dns_ok = if let Some(first_dns) = dns_b.first() {
                                        let set_dns = std::process::Command::new("netsh")
                                            .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                            .args(["interface", "ip", "set", "dns",
                                                &format!("name={}", iface_b), "static", first_dns])
                                            .output();
                                        let primary_ok = match set_dns {
                                            Ok(out) if out.status.success() => true,
                                            Ok(out) => {
                                                errors.push(format!("set dns 失败: {}", String::from_utf8_lossy(&out.stderr)));
                                                false
                                            }
                                            Err(e) => {
                                                errors.push(format!("set dns 错误: {}", e));
                                                false
                                            }
                                        };
                                        // 追加备用 DNS：index 从 2 开始（1 为首选）
                                        let mut all_ok = primary_ok;
                                        for (i, extra_dns) in dns_b.iter().enumerate().skip(1) {
                                            let add_dns = std::process::Command::new("netsh")
                                                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                                .args(["interface", "ip", "add", "dns",
                                                    &format!("name={}", iface_b), extra_dns,
                                                    &format!("index={}", i + 2)])
                                                .output();
                                            match add_dns {
                                                Ok(out) if out.status.success() => {}
                                                Ok(out) => {
                                                    errors.push(format!("add dns {} 失败: {}", extra_dns, String::from_utf8_lossy(&out.stderr)));
                                                    all_ok = false;
                                                }
                                                Err(e) => {
                                                    errors.push(format!("add dns {} 错误: {}", extra_dns, e));
                                                    all_ok = false;
                                                }
                                            }
                                        }
                                        all_ok
                                    } else {
                                        true // dns 列表为空，跳过
                                    };
                                    (addr_ok, dns_ok, errors)
                                }).await.unwrap_or((false, false, Vec::new()));
                                let success = addr_ok && dns_ok;
                                if success {
                                    let reply = serde_json::json!({
                                        "action": "set_ip",
                                        "success": true,
                                        "data": {
                                            "interface": interface_for_reply,
                                            "ip": ip_addr_for_reply,
                                            "mask": mask_for_reply,
                                            "gateway": gateway_for_reply
                                        }
                                    }).to_string();
                                    let _ = ack_tx.send(Message::Text(reply)).await;
                                } else {
                                    let reply = serde_json::json!({
                                        "action": "set_ip",
                                        "success": false,
                                        "data": {
                                            "interface": interface_for_reply,
                                            "ip": ip_addr_for_reply,
                                            "mask": mask_for_reply,
                                            "gateway": gateway_for_reply
                                        },
                                        "error": errors.join("; ")
                                    }).to_string();
                                    let _ = ack_tx.send(Message::Text(reply)).await;
                                }
                            }
                        }
                        // 远程关机：cmd /C shutdown /s /f /t 0（CREATE_NO_WINDOW 防弹黑窗）
                        "shutdown" => {
                            log_info!("[Shutdown] Executing shutdown /s /f /t 0");
                            let out = tokio::task::spawn_blocking(move || {
                                std::process::Command::new("cmd")
                                    .args(["/C", "shutdown", "/s", "/f", "/t", "0"])
                                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                                    .output()
                            }).await.ok().and_then(|r| r.ok());
                            match out {
                                Some(o) if o.status.success() => {
                                    log_info!("[Shutdown] command succeeded, device shutting down");
                                    let reply = serde_json::json!({
                                        "action": "shutdown",
                                        "success": true,
                                        "data": {}
                                    }).to_string();
                                    let _ = ack_tx.send(Message::Text(reply)).await;
                                }
                                Some(o) => {
                                    let err = String::from_utf8_lossy(&o.stderr).to_string();
                                    log_warn!("[Shutdown] failed: {}", err);
                                    let reply = serde_json::json!({
                                        "action": "shutdown",
                                        "success": false,
                                        "error": format!("shutdown 失败: {}", err)
                                    }).to_string();
                                    let _ = ack_tx.send(Message::Text(reply)).await;
                                }
                                None => {
                                    let reply = serde_json::json!({
                                        "action": "shutdown",
                                        "success": false,
                                        "error": "无法执行 shutdown 命令"
                                    }).to_string();
                                    let _ = ack_tx.send(Message::Text(reply)).await;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                }
                Message::Pong(_) => {
                    // 收到 Pong：更新心跳时间戳，供 priority_sender 的心跳超时检测使用
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    LAST_PONG_TIME.store(now, Ordering::Relaxed);
                }
                _ => {}
            }
        }

        // Release all pressed keys on disconnect
        let pressed = lock_state!(PRESSED_KEYS).drain().collect::<Vec<_>>();
        for vk in pressed {
            #[cfg(windows)]
            {
                let input = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk),
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                send_input_raw(&[input]);
            }
        }
        CONNECTED.store(false, Ordering::Relaxed);
    }));

    // === 核心优化: 将繁重的 CPU 捕获和压缩剥离到独立的 OS 线程 ===
    // 这样就不会阻塞 Tokio 的异步网络 I/O（WebSocket 读写可以极速响应）
    // 生命周期管理：独立 video_shutdown 信号 + JoinHandle 保存，重连前 join 回收，防止线程泄漏
    let video_shutdown_clone = video_shutdown.clone();
    video_handle = Some(std::thread::spawn(move || {
        log_info!("[VideoThread] started");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut prev_frame_hash: u64 = 0;
        let mut last_cursor_type: u8 = 0;
        let mut last_sent_frame_time = std::time::Instant::now();
        let mut last_keepalive_time = std::time::Instant::now();
        // 最近一次缩略图快照时间：空闲常驻资源在长时间无快照后释放（避免常驻，同时避免反复创建销毁 DXGI 泄漏）
        let mut last_snapshot_time = std::time::Instant::now();
        // 帧路径打点：仅记录耗时样本，每 5 秒随状态日志输出一次 p50/p95
        let mut perf_capture_ms: Vec<u32> = Vec::with_capacity(256);
        let mut perf_encode_ms: Vec<u32> = Vec::with_capacity(256);
        // 静态画面二进制保活周期：scrap 的 DXGI 采集为 0ms 超时，画面无变化时拿不到帧，
        // 长时间无任何二进制消息会让前端误判"已冻结"
        const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
        // 连续 DXGI 错误（如 ACCESS_LOST）超过该次数则断开重连，由重连循环重建采集器
        const DXGI_ERROR_RECONNECT_THRESHOLD: u32 = 3;
        // 空闲超过该时长且无快照请求时，释放采集资源回到低内存
        const IDLE_SNAPSHOT_RELEASE: std::time::Duration = std::time::Duration::from_secs(300);
        loop {
            if !CONNECTED.load(Ordering::Relaxed) || video_shutdown_clone.load(Ordering::Relaxed) {
                break;
            }
            if CAPTURE_PAUSED.load(Ordering::Relaxed) {
                // 空闲态缩略图快照：改用 GDI BitBlt 瞬态采集（GDI 对象创建/销毁干净无泄漏），
                // 不再创建/常驻 DXGI 采集器——DXGI 反复创建销毁会在驱动层残留线程/内存（历史教训），
                // 也避免待机常驻大资源导致内存与远程控制相近。
                if SNAPSHOT_REQUESTED.swap(false, Ordering::Relaxed) {
                    // compressor 常驻复用（体积小）；帧缓冲与 GDI 采集器均为瞬态，快照后释放
                    if compressor.is_none() {
                        match Compressor::new() {
                            Ok(c) => compressor = Some(c),
                            Err(e) => log_warn!("[VideoThread] Snapshot: Compressor create failed: {}", e),
                        }
                    }
                    if frame_buffer.is_none() {
                        let (sw, sh) = screen_res;
                        frame_buffer = Some(Vec::with_capacity(sw * sh * 4));
                    }
                    if let (Some(comp), Some(fb)) = (compressor.as_mut(), frame_buffer.as_mut()) {
                        if let Some(mut gdi) = GDICapturer::new() {
                            if gdi.capture_frame(fb) {
                                let (gw, gh) = (gdi.width, gdi.height);
                                let frame_data: &[u8] = fb;
                                comp.set_quality(40);
                                comp.set_subsamp(turbojpeg::Subsamp::Sub2x2);
                                let encode_start = std::time::Instant::now();
                                match comp.compress_to_vec(Image {
                                    pixels: frame_data, width: gw, height: gh, pitch: gw * 4, format: PixelFormat::BGRA,
                                }) {
                                    Ok(jpeg_bytes) => {
                                        let encode_ms = encode_start.elapsed().as_millis();
                                        // 全帧帧类型 0x02，坐标 (0,0)，尺寸为屏幕
                                        if tx.try_send(Message::Binary(
                                            build_binary_packet(0x02, 0, 0, gw as u16, gh as u16, &jpeg_bytes, get_current_cursor_type())
                                        )).is_ok() {
                                            last_sent_frame_time = std::time::Instant::now();
                                            log_info!("[VideoThread] Snapshot sent: {} bytes, {} ms (GDI)", jpeg_bytes.len(), encode_ms);
                                        } else {
                                            log_warn!("[VideoThread] Snapshot: send queue full, frame dropped");
                                        }
                                    }
                                    Err(e) => log_warn!("[VideoThread] Snapshot: JPEG compress failed: {}", e),
                                }
                            } else {
                                log_warn!("[VideoThread] Snapshot: GDI capture_frame failed");
                            }
                        } else {
                            log_warn!("[VideoThread] Snapshot: GDI init failed");
                        }
                    } else {
                        log_warn!("[VideoThread] Snapshot: resource init incomplete, skip send");
                    }
                    // 释放瞬态帧缓冲（GDI 采集器随 gdi 析构自动清理），仅常驻 compressor/quality_engine
                    frame_buffer = None;
                    unsafe {
                        mi_collect(true);
                    }
                    last_snapshot_time = std::time::Instant::now();
                    continue;
                }
                // 进入暂停态：释放 DXGI 采集器与大缓冲（快照已改用 GDI，不再需要 DXGI）
                if capturer.is_some() || grid_mgr.is_some() || frame_buffer.is_some() || block_buffer.is_some() || downsample_buffer.is_some() {
                    capturer = None;
                    grid_mgr = None;
                    frame_buffer = None;
                    block_buffer = None;
                    downsample_buffer = None;
                    log_info!("[VideoThread] Released DXGI/large resources (idle mode)");
                    unsafe {
                        mi_collect(true);
                    }
                }
                // 长时间无快照请求（空闲超时）：连 compressor/quality_engine 也释放，回到最低内存
                if (compressor.is_some() || quality_engine.is_some())
                    && last_snapshot_time.elapsed() >= IDLE_SNAPSHOT_RELEASE {
                    compressor = None;
                    quality_engine = None;
                    log_info!("[VideoThread] Released compressor/quality engine (no snapshots for {}s)", IDLE_SNAPSHOT_RELEASE.as_secs());
                    unsafe {
                        mi_collect(true);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }

            // 惰性初始化：逐项补齐缺失资源（快照路径可能已持有 capturer/compressor/frame_buffer，
            // 恢复推流时必须把其余资源也补齐，不能以 capturer 是否就绪作为整体就绪标志）
            let need_init = capturer.is_none()
                || grid_mgr.is_none()
                || compressor.is_none()
                || quality_engine.is_none()
                || frame_buffer.is_none()
                || block_buffer.is_none()
                || downsample_buffer.is_none();
            if need_init {
                if capturer.is_none() {
                    match ScreenCapturer::new() {
                        Ok(c) => {
                            capturer = Some(c);
                        }
                        Err(e) => {
                            log_warn!("[VideoThread] Failed to create ScreenCapturer: {}", e);
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            continue;
                        }
                    }
                }
                if grid_mgr.is_none() {
                    let (sw, sh) = screen_res;
                    grid_mgr = Some(GridManager::new(sw, sh, grid_size));
                }
                if compressor.is_none() {
                    match Compressor::new() {
                        Ok(c) => compressor = Some(c),
                        Err(e) => {
                            log_error!("[VideoThread] Failed to create Compressor: {}", e);
                            // 不复用已存在资源置 None（避免 DXGI 反复创建销毁），仅等待后重试
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            continue;
                        }
                    }
                }
                if quality_engine.is_none() {
                    quality_engine = Some(QualityEngine::new());
                }
                if frame_buffer.is_none() {
                    let (sw, sh) = screen_res;
                    frame_buffer = Some(Vec::with_capacity(sw * sh * 4));
                }
                if block_buffer.is_none() {
                    block_buffer = Some(Vec::with_capacity(grid_size * grid_size * 4));
                }
                if downsample_buffer.is_none() {
                    let (sw, sh) = screen_res;
                    downsample_buffer = Some(Vec::with_capacity((sw / 2) * (sh / 2) * 4));
                }
                if capturer.is_some()
                    && grid_mgr.is_some()
                    && compressor.is_some()
                    && quality_engine.is_some()
                    && frame_buffer.is_some()
                    && block_buffer.is_some()
                    && downsample_buffer.is_some()
                {
                    log_info!("[VideoThread] All resources initialized, starting capture");
                }
            }

            // 获取所有资源的可变引用（防御性解包：任一为 None 则跳过本帧，下一轮循环会重新执行惰性初始化）
            if let (Some(cap), Some(gm), Some(comp), Some(qe), Some(fb), Some(bb), Some(db)) = (
                capturer.as_mut(),
                grid_mgr.as_mut(),
                compressor.as_mut(),
                quality_engine.as_mut(),
                frame_buffer.as_mut(),
                block_buffer.as_mut(),
                downsample_buffer.as_mut(),
            ) {
                let frame_start = std::time::Instant::now();
                let cursor_type = get_current_cursor_type();
                // 光标类型变化时，立即通过独立 0x0A 消息发送（不依赖视频帧）
                if cursor_type != last_cursor_type {
                    last_cursor_type = cursor_type;
                    let cursor_msg = vec![0x0Au8, cursor_type];
                    let _ = tx.try_send(Message::Binary(cursor_msg));
                }
                // 使用预初始化的 cap 进行截图，结果写入复用的 fb
                match cap.capture_frame(fb) {
                    Ok(()) => {
                        let frame_data: &[u8] = fb;
                        perf_capture_ms.push(frame_start.elapsed().as_millis() as u32);
                        dxgi_error_count = 0;
                        // === xxhash64 全帧哈希静态帧跳过 ===
                        // 画面无变化时跳过编码/发送全部流程，大幅降低 CPU/带宽
                        let frame_hash = xxh64(&frame_data, 0);
                        if frame_hash == prev_frame_hash {
                            // 静态帧：跳过编码/发送；长时间无帧时补发 0x0B 心跳，避免前端误判冻结
                            if last_sent_frame_time.elapsed() >= KEEPALIVE_INTERVAL
                                && last_keepalive_time.elapsed() >= KEEPALIVE_INTERVAL
                                && tx.try_send(Message::Binary(vec![0x0Bu8, 0])).is_ok()
                            {
                                last_keepalive_time = std::time::Instant::now();
                            }
                            std::thread::sleep(std::time::Duration::from_millis(33));
                            continue;
                        }
                        prev_frame_hash = frame_hash;

                        let (dirty_blocks, change_ratio) = gm.detect_dirty_blocks(frame_data);

                        // === 优化3: 从 AtomicU32 读取节流后的 CPU 负载 ===
                        let cpu_load = CPU_LOAD.load(Ordering::Relaxed) as f32 / 10.0;

                        let is_video = !first_frame && change_ratio > 0.50;
                        let _is_static = change_ratio < 0.02;
                        let force_key = qe.need_keyframe()
                            || FORCE_KEY_REQUESTED.swap(false, Ordering::Relaxed);
                        first_frame = false;

                        // === 应用前端画质档位 ===
                        // 在 adapt() 之前设置 min/max，让自动引擎在档位范围内动态调节
                        let profile = QUALITY_PROFILE.load(Ordering::Relaxed);
                        match profile {
                            30 => { // 流畅
                                qe.min_quality = 40;
                                qe.max_quality = 55;
                            }
                            75 => { // 高清
                                qe.min_quality = 80;
                                qe.max_quality = 95;
                            }
                            _ => { // 50=均衡（默认）
                                qe.min_quality = 60;
                                qe.max_quality = 75;
                            }
                        }
                        qe.quality = qe.quality.clamp(
                            qe.min_quality, qe.max_quality);

                        comp.set_quality(qe.quality);
                        comp.set_subsamp(if is_video { turbojpeg::Subsamp::Sub2x2 } else { turbojpeg::Subsamp::None });

                        let mut frame_send_bytes = 0usize;
                        let mut encode_total_ms = 0u64;
                        let mut network_dropped = false;

                        if is_video || force_key || (dirty_blocks.len() as f32) > (gm.last_hashes.len() as f32 * 0.45) {
                            // 全帧模式
                            let encode_start = std::time::Instant::now();

                            let jpeg_result = if is_video {
                                // 降采样 1/2，大幅降低 CPU 开销
                                downsample_bgra_2x(frame_data, screen_w, screen_h, db);
                                comp.compress_to_vec(Image {
                                    pixels: db,
                                    width: screen_w / 2,
                                    height: screen_h / 2,
                                    pitch: (screen_w / 2) * 4,
                                    format: PixelFormat::BGRA,
                                })
                            } else {
                                comp.compress_to_vec(Image {
                                    pixels: frame_data, width: screen_w, height: screen_h, pitch: screen_w * 4, format: PixelFormat::BGRA,
                                })
                            };

                            if let Ok(jpeg_bytes) = jpeg_result {
                                encode_total_ms = encode_start.elapsed().as_millis() as u64;
                                frame_send_bytes = jpeg_bytes.len();

                                // flag 0x03 means 1/2 scaled full frame, 0x02 means full frame
                                let frame_flag = if is_video { 0x03 } else { 0x02 };

                                // 优化1: 非阻塞 try_send，通道满则丢弃
                                if tx.try_send(Message::Binary(
                                    build_binary_packet(frame_flag, 0, 0, screen_w as u16, screen_h as u16, &jpeg_bytes, cursor_type)
                                )).is_err() {
                                    network_dropped = true;
                                } else {
                                    last_sent_frame_time = std::time::Instant::now();
                                }
                            }
                        } else if !dirty_blocks.is_empty() {
                            // 增量模式：连通分量包围盒合并（参照 VNC/X11 Damage 做法）
                            let merged = gm.merge_connected_components(&dirty_blocks);
                            for block in &merged {
                                // 优化2: 复用 bb，clear + 原地覆写
                                extract_block_rgba_into(frame_data, block, screen_w, bb);
                                let encode_start = std::time::Instant::now();
                                if let Ok(jpeg_bytes) = comp.compress_to_vec(Image {
                                    pixels: bb,
                                    width: block.w as usize,
                                    height: block.h as usize,
                                    pitch: block.w as usize * 4,
                                    format: PixelFormat::BGRA,
                                }) {
                                    encode_total_ms += encode_start.elapsed().as_millis() as u64;
                                    frame_send_bytes += jpeg_bytes.len();

                                    // 优化1: 非阻塞发送
                                    if tx.try_send(Message::Binary(
                                        build_binary_packet(0x01, block.x, block.y, block.w, block.h, &jpeg_bytes, cursor_type)
                                    )).is_err() {
                                        network_dropped = true;
                                        break;
                                    } else {
                                        last_sent_frame_time = std::time::Instant::now();
                                    }
                                }
                            }
                        }

                        if network_dropped {
                            gm.last_hashes.fill(0);
                        }
                        if encode_total_ms > 0 {
                            perf_encode_ms.push(encode_total_ms as u32);
                        }

                        // 带宽统计
                        let now = std::time::Instant::now();
                        send_history.push_back((now, frame_send_bytes));
                        while send_history.front().map_or(false, |(t, _)| now.duration_since(*t).as_millis() > 1000) {
                            send_history.pop_front();
                        }
                        let send_kbps = send_history.iter().map(|(_, b)| b).sum::<usize>() as f32 / 1024.0;
                        qe.adapt(change_ratio, cpu_load, encode_total_ms, send_kbps);

                        if status_log_timer.elapsed().as_secs() >= 5 {
                            qe.log_status();
                            log_info!("  CPU={:.0}% change={:.1}% blocks={} send={:.0}KB/s",
                                cpu_load, change_ratio * 100.0, dirty_blocks.len(), send_kbps);
                            if !perf_capture_ms.is_empty() || !perf_encode_ms.is_empty() {
                                let mut cap = perf_capture_ms.clone();
                                cap.sort_unstable();
                                let mut enc = perf_encode_ms.clone();
                                enc.sort_unstable();
                                log_info!("  perf capture p50={}ms p95={}ms | encode p50={}ms p95={}ms | n={}",
                                    percentile(&cap, 0.50), percentile(&cap, 0.95),
                                    percentile(&enc, 0.50), percentile(&enc, 0.95), cap.len());
                                perf_capture_ms.clear();
                                perf_encode_ms.clear();
                            }
                            status_log_timer = std::time::Instant::now();
                        }
                    }
                    Err(CaptureError::WouldBlock) => {
                        // scrap 的 DXGI 采集使用 0ms 超时：静态画面没有新帧属正常状态，
                        // 不是截屏器故障，不能据此重连
                        dxgi_error_count = 0;
                    }
                    Err(CaptureError::DxgiError(desc)) => {
                        dxgi_error_count += 1;
                        log_error!("[Capture] DXGI error #{}/{}: {}", dxgi_error_count, DXGI_ERROR_RECONNECT_THRESHOLD, desc);
                        if dxgi_error_count >= DXGI_ERROR_RECONNECT_THRESHOLD {
                            // ACCESS_LOST 等错误需要重建采集器（重连循环会重建整个会话）
                            log_error!("[Capture] Too many consecutive DXGI errors, reconnecting to rebuild capturer");
                            CONNECTED.store(false, Ordering::Relaxed);
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                    Err(CaptureError::GdiError) | Err(CaptureError::NoData) => {}
                }

                // 静态画面保活：周期发送 2 字节心跳（0x0B），只用于前端判断链路存活
                if last_sent_frame_time.elapsed() >= KEEPALIVE_INTERVAL
                    && last_keepalive_time.elapsed() >= KEEPALIVE_INTERVAL
                    && tx.try_send(Message::Binary(vec![0x0Bu8, 0])).is_ok()
                {
                    last_keepalive_time = std::time::Instant::now();
                }

                let elapsed_ms = frame_start.elapsed().as_millis() as u64;
                // 固定 33ms 帧间隔（约 30fps），替代动态 framerate 调节
                // 静态画面通过 xxhash64 跳过，动态画面保证稳定帧率
                if elapsed_ms < 33 {
                    std::thread::sleep(std::time::Duration::from_millis(33 - elapsed_ms));
                }
            } else {
                log_error!("[VideoThread] Resource init broken, skipping frame");
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        }
        }));
        if result.is_err() {
            log_error!("[VideoThread] panic caught, reconnecting");
            CONNECTED.store(false, Ordering::Relaxed);
        }
        log_info!("[VideoThread] exited");
    }));

    // 等待：收到 ctrl_c 或 连接断开
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            // 设置全局 SHUTDOWN 标志，让重连等待循环也能立即退出
            SHUTDOWN.store(true, Ordering::Relaxed);
            // 通知视频线程退出（进程即将结束，无需等待 join）
            video_shutdown.store(true, Ordering::Relaxed);
            log_info!("Agent shutting down...");
            // 清理所有终端会话
            terminal::shutdown_all();
            *lock_state!(TERM_EVENT_TX) = None;
            break 'reconnect;
        }
        _ = async {
            while CONNECTED.load(Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        } => {
            // 通知视频线程退出并回收，防止旧线程在重连（CONNECTED 重新置 true）后永久空转泄漏
            video_shutdown.store(true, Ordering::Relaxed);
            if let Some(handle) = video_handle.take() {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while !handle.is_finished() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                if handle.is_finished() {
                    let _ = handle.join();
                    log_info!("[VideoThread] joined and recycled");
                } else {
                    // Rust 无法强制终止线程：超时后放弃等待，线程会在下一个循环检查点自行退出
                    log_warn!("[VideoThread] join timed out after 2s, thread will exit on next checkpoint");
                }
            }
            // Abort old tokio tasks to prevent memory leaks from half-open WebSocket connections
            if let Some(h) = priority_sender_handle.take() {
                h.abort();
            }
            if let Some(h) = control_handler_handle.take() {
                h.abort();
            }
            let jitter = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() % 1000) as u64;
            log_warn!("[Reconnect] Connection lost, will reconnect after {}s...", retry_delay);
            // 连接断开：终止所有终端会话并清空事件通道（转发线程随 sender 掉落自动退出）
            terminal::shutdown_all();
            *lock_state!(TERM_EVENT_TX) = None;
            let base = (retry_delay * 2).min(60).max(1);
            let jitter = (jitter % std::cmp::min(base * 1000, 5000)) / 1000;
            retry_delay = (base + jitter).min(65); // 上限 65s（含 jitter 后不超过这个值）
            continue;
        }
    }
    }
}
