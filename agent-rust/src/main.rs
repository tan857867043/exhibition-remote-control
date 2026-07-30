mod dirty_rect;
mod capture;
mod encoder;
mod config;

use capture::{ScreenCapturer, CaptureError};

use dirty_rect::GridManager;
use encoder::{build_binary_packet, extract_block_rgba_into, downsample_bgra_2x};
use enigo::{Enigo, MouseControllable, MouseButton};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sha2::{Sha256, Digest};
use xxhash_rust::xxh64::xxh64;
use std::collections::{VecDeque, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicBool, AtomicI32, Ordering};
use std::sync::{Mutex, LazyLock, OnceLock};
use std::fs::File;
use std::io::{Read, Write};
use sysinfo::System;
use tokio_tungstenite::tungstenite::Message;
use turbojpeg::{Compressor, Image, PixelFormat};

#[cfg(windows)]
extern "system" {
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
    println!("[KEY] send_key vk=0x{:02X} scan=0x{:02X} action={}", vk, scan, action);
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
// 画质档位（前端控制: 30=流畅, 50=均衡, 75=高清）
static QUALITY_PROFILE: AtomicI32 = AtomicI32::new(50);

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
        println!(
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
        s if s.len() == 1 => Some(s.chars().next().unwrap() as u16),
        "F1" => Some(0x70), "F2" => Some(0x71), "F3" => Some(0x72),
        "F4" => Some(0x73), "F5" => Some(0x74), "F6" => Some(0x75),
        "F7" => Some(0x76), "F8" => Some(0x77), "F9" => Some(0x78),
        "F10" => Some(0x79), "F11" => Some(0x7A), "F12" => Some(0x7B),
        _ => None,
    }
}



fn send_download_chunk(ack_tx: &tokio::sync::mpsc::Sender<Message>) {
    let mut ds = DOWNLOAD_STATE.lock().unwrap();
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
    let header: u32 = if is_last { 0x01000001 } else { 0x01000000 };

    let mut packet = Vec::with_capacity(4 + bytes_read);
    packet.extend_from_slice(&header.to_be_bytes());
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
                    PRESSED_KEYS.lock().unwrap().insert(vk);
                } else {
                    PRESSED_KEYS.lock().unwrap().remove(&vk);
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
            let mut ft = FILE_TRANSFER.lock().unwrap();
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
            let mut ft = FILE_TRANSFER.lock().unwrap();
            if let Some(mut transfer) = ft.take() {
                let _ = transfer.file.flush();
                let tmp_path = transfer.tmp_path.clone();
                let final_path = transfer.final_path.clone();
                let file_name = transfer.file_name.clone();
                let total_size = transfer.total_size;
                let expected_checksum = transfer.checksum.clone();
                drop(transfer); // 关闭文件句柄
                drop(ft);

                // 读取 .tmp 文件，计算 SHA-256
                match std::fs::read(&tmp_path) {
                    Ok(file_bytes) => {
                        let mut hasher = Sha256::new();
                        hasher.update(&file_bytes);
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
                            eprintln!("Failed to rename tmp file: {}", e);
                            let _ = std::fs::remove_file(&tmp_path);
                            return;
                        }

                        let done = format!(
                            r#"{{"action":"file_done","file_name":"{}","path":"{}","size":{},"checksum":"{}"}}"#,
                            file_name, final_path.replace('\\', "\\\\"), total_size, checksum_hex
                        );
                        let _ = ack_tx.try_send(Message::Text(done));
                        println!("File transfer complete: {} ({} bytes)", file_name, total_size);
                    }
                    Err(e) => {
                        eprintln!("Failed to read tmp file for checksum: {}", e);
                        let _ = std::fs::remove_file(&tmp_path);
                    }
                }
            }
        }
        0x09 => {
            let mut us = UPLOAD_STATE_V2.lock().unwrap();
            if let Some(ref mut state) = *us {
                if !state.done {
                    let chunk_data = &data[1..];
                    if let Err(e) = state.file.write_all(chunk_data) {
                        eprintln!("Failed to write upload chunk: {}", e);
                        return;
                    }
                    state.received_size += chunk_data.len() as u64;
                    if let Err(e) = state.file.flush() {
                        eprintln!("Failed to flush upload file: {}", e);
                    }
                }
            }
        }
        _ => {}
    }
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
    println!("[Agent] send_list_dir called, path: '{}'", path);

    if path.is_empty() {
        let mut drives = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if std::path::Path::new(&drive).exists() {
                let (total, free, dtype, label) = get_disk_info_windows(&drive);
                println!("[Agent] Found drive: {} total={} free={} type={} label={}", drive, total, free, dtype, label);
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
        println!("[Agent] Sending list_dir_result (drives): {} drives", drives.len());
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
            println!("[Agent] Sending list_dir_result for '{}': {} entries", path, result.len());
            let _ = ack_tx.try_send(Message::Text(reply));
        }
        Err(e) => {
            println!("[Agent] list_dir error for '{}': {}", path, e);
            let _ = ack_tx.try_send(Message::Text(
                format!(r#"{{"action":"list_dir_error","error":"{}"}}"#, e)
            ));
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    // 全局 panic hook: 任何线程 panic 都打日志，不崩溃
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[PANIC] {}", info);
    }));
    println!("Exhibition Agent starting (industry-grade pipeline)...");

    // Generate or load Device ID (只做一次)
    let device_id = std::fs::read_to_string(".device_id").unwrap_or_else(|_| {
        let mut sys = System::new_all();
        sys.refresh_all();
        let host = System::host_name().unwrap_or_else(|| "UnknownHost".to_string());
        let new_id = format!("{}_{}_{}", host, std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        let hash = crc32fast::hash(new_id.as_bytes());
        let id_str = format!("{:08x}", hash);
        let _ = std::fs::write(".device_id", &id_str);
        id_str
    }).trim().to_string();

    let mut sys = System::new_all();
    sys.refresh_all();
    let host_name = System::host_name().unwrap_or_else(|| "Unknown Device".to_string());
    let os_name = format!("{} {}", System::name().unwrap_or_else(|| "Unknown OS".to_string()), System::os_version().unwrap_or_default());
    let cpu_brand = sys.cpus().first().map(|c| c.brand()).unwrap_or("Unknown CPU").to_string();
    let mem_gb = (sys.total_memory() as f64 / 1_073_741_824.0).round() as u64;
    let mut mac_addr = String::new();
    let networks = sysinfo::Networks::new_with_refreshed_list();
    for (name, data) in &networks {
        if name != "lo" && !name.starts_with("Loopback") {
            mac_addr = format!("{:?}", data.mac_address());
            break;
        }
    }
    let host_name_encoded = host_name.replace(" ", "%20");
    let os_name_encoded = os_name.replace(" ", "%20");
    let cpu_brand_encoded = cpu_brand.replace(" ", "%20");
    let mac_encoded = mac_addr.replace(" ", "%20");
    let server_url = config::resolve_server_url();
    let url = format!("{}/agent/register?device_id={}&device_name={}&os={}&cpu={}&ram={}GB&mac={}", 
        server_url.trim_end_matches('/'), device_id, host_name_encoded, os_name_encoded, cpu_brand_encoded, mem_gb, mac_encoded);

    let mut retry_delay = 1u64;
    loop {
        // 每轮连接重新创建所有状态
        let mut capturer = match ScreenCapturer::new() {
            Ok(c) => c,
            Err(e) => {
                println!("[Agent] WARNING: DXGI capture unavailable ({}), falling back to GDI BitBlt (restarting)", e);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                retry_delay = 2;
                continue;
            }
        };
        let mut dxgi_error_count: u32 = 0;
        let screen_w = capturer.width;
        let screen_h = capturer.height;
        let grid_size = 64;
        let mut grid_mgr = GridManager::new(screen_w, screen_h, grid_size);
        let mut compressor = Compressor::new().unwrap();
        let mut quality_engine = QualityEngine::new();
        let mut send_history: VecDeque<(std::time::Instant, usize)> = VecDeque::new();
        let mut status_log_timer = std::time::Instant::now();
        let mut first_frame = true;

        CONNECTED.store(false, Ordering::Relaxed);

        if retry_delay > 1 {
            println!("[Reconnect] Waiting {}s before retry...", retry_delay);
        }
        tokio::time::sleep(std::time::Duration::from_secs(retry_delay)).await;

        println!("Connecting to hub at {}", url);
        let (ws_stream, _) = match tokio_tungstenite::connect_async(url.clone()).await {
            Ok(s) => { retry_delay = 1; s }
            Err(e) => {
                println!("[Reconnect] Connection failed: {}, retrying...", e);
                retry_delay = (retry_delay * 2).min(30);
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

    // === 优先级队列：高优(视频+控制) + 低优(文件传输) ===
    // 高优通道：视频帧、控制响应、ACK 等（永远优先发送）
    let (high_tx, mut high_rx) = tokio::sync::mpsc::channel::<Message>(4096);
    let ack_tx = high_tx.clone(); // 控制命令响应走高优
    let tx = high_tx.clone(); // 视频帧发送也走高优

    // 低优通道：文件传输数据块（仅当高优队列为空时才发送）
    let (low_tx, mut low_rx) = tokio::sync::mpsc::channel::<Message>(4096);
    let file_tx = low_tx.clone(); // 文件传输数据走低优

    // 优先级发送任务：永远优先处理高优队列
    tokio::spawn(async move {
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
                else => break,
            }
        }
        CONNECTED.store(false, Ordering::Relaxed);
    });

    // === 优化3: CPU 监控任务（独立定时器 500ms 刷新，避免每帧 sysinfo 开销）===
    tokio::spawn(async move {
        let mut sys = System::new_all();
        loop {
            sys.refresh_cpu();
            // 等一小段时间让 Delta 采样有意义
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            sys.refresh_cpu();
            let load = cpus_avg(&sys);
            // 存为千分比整数（如 35.2% → 352），AtomicU32 不能存 f32
            CPU_LOAD.store((load * 10.0) as u32, Ordering::Relaxed);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    });

    // 控制命令处理
    tokio::spawn(async move {
        let file_tx = file_tx.clone();
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_binary_msg(&data, &ack_tx);
                    }));
                    if let Err(e) = result {
                        eprintln!("[Agent] handle_binary_msg panic (已恢复): {:?}", e);
                    }
                }
                Ok(Message::Text(text)) => {
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
                                println!("[KEY] vk=0x{:02X} down={}", kc.vk, kc.down);
                                #[cfg(windows)]
                                send_key(kc.vk, if kc.down { 0 } else { 1 });
                            } else {
                                println!("[KEY] parse KeyCmd FAILED from: {}", text);
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
                            println!("Capture paused (no subscribers)");
                        }
                        "resume" => {
                            CAPTURE_PAUSED.store(false, Ordering::Relaxed);
                            println!("Capture resumed (subscriber connected)");
                        }
                        "quality" => {
                            if let Some(value) = cmd.value {
                                QUALITY_PROFILE.store(value, Ordering::Relaxed);
                                println!("Quality profile set to {}", value);
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
                                    eprintln!("Failed to create directory {}: {}", target_dir, e);
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
                                        eprintln!("Failed to create empty tmp file: {}", e);
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
                                        eprintln!("Failed to rename empty tmp file: {}", e);
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
                                            let filename = p.file_name().unwrap().to_str().unwrap();
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
                                                    let new_final_str = new_final.to_str().unwrap().to_string();
                                                    let new_tmp_str = format!("{}.tmp", new_final_str);
                                                    // 使用新名称
                                                    match std::fs::OpenOptions::new()
                                                        .create_new(true).write(true)
                                                        .open(&new_tmp_str)
                                                    {
                                                        Ok(file) => {
                                                            println!("Receiving file: {} ({} bytes, {} chunks) [renamed]", new_final_str, fc.file_size, fc.total_chunks);
                                                            let mut ft_lock = FILE_TRANSFER.lock().unwrap();
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
                                                            eprintln!("Failed to create temp file: {}", e);
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
                                            eprintln!("Failed to open tmp file for append: {}", e);
                                            continue;
                                        }
                                    }
                                } else {
                                    // 创建新文件
                                    match File::create(&tmp_path) {
                                        Ok(f) => f,
                                        Err(e) => {
                                            eprintln!("Failed to create tmp file {}: {}", tmp_path, e);
                                            continue;
                                        }
                                    }
                                };

                                println!("Receiving file: {} ({} bytes, {} chunks)", fc.file_name, fc.file_size, fc.total_chunks);
                                let mut ft_lock = FILE_TRANSFER.lock().unwrap();
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
                            let mut ft = FILE_TRANSFER.lock().unwrap();
                            if let Some(transfer) = ft.take() {
                                let _ = std::fs::remove_file(&transfer.tmp_path);
                                println!("File transfer cancelled: {}", transfer.file_name);
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
                                            eprintln!("Failed to create directory {}: {}", dc.path, e);
                                        }
                                    }
                                    Err(_) => {
                                        if let Err(e) = std::fs::create_dir_all(&dc.path) {
                                            eprintln!("Failed to create directory {}: {}", dc.path, e);
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
                                                eprintln!("Failed to copy {}: {}", src, e);
                                                success = false;
                                            }
                                        }
                                        Err(e) => {
                                            eprintln!("Failed to access {}: {}", src, e);
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
                                                    eprintln!("Failed to remove source {}: {}", src, e);
                                                    success = false;
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!("Failed to copy {}: {}", src, e);
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
                                                let mut ds = DOWNLOAD_STATE.lock().unwrap();
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
                                                    r#"{{"action":"download","sub":"start","id":"{}","size":{}}}"#,
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
                                        let mut ds = DOWNLOAD_STATE.lock().unwrap();
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
                                        let mut ds = DOWNLOAD_STATE.lock().unwrap();
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
                                        let mut ds = DOWNLOAD_STATE.lock().unwrap();
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
                                    let file_data = match std::fs::read(&path) {
                                        Ok(data) => data,
                                        Err(e) => {
                                            let _ = ack.try_send(Message::Text(
                                                format!(r#"{{"action":"file_error","error":"{}"}}"#, e)
                                            ));
                                            return;
                                        }
                                    };
                                    let chunk_size = 64 * 1024;
                                    let total_chunks = ((file_data.len() as f64) / (chunk_size as f64)).ceil() as u32;

                                    // Send ready
                                    let _ = ack.try_send(Message::Text(
                                        format!(r#"{{"action":"file_download_ready","size":{},"total_chunks":{}}}"#,
                                            file_data.len(), total_chunks)
                                    ));

                                    // Send chunks
                                    for i in 0..total_chunks {
                                        let begin = (i as usize) * chunk_size;
                                        let end = std::cmp::min(begin + chunk_size, file_data.len());
                                        let chunk = &file_data[begin..end];

                                        let mut packet = Vec::with_capacity(5 + chunk.len());
                                        packet.push(0x08); // file download chunk type
                                        packet.push(((i >> 8) & 0xFF) as u8);
                                        packet.push((i & 0xFF) as u8);
                                        packet.push(((total_chunks >> 8) & 0xFF) as u8);
                                        packet.push((total_chunks & 0xFF) as u8);
                                        packet.extend_from_slice(chunk);

                                        if file.try_send(Message::Binary(packet)).is_err() {
                                            return;
                                        }
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
                            #[derive(Deserialize)]
                            struct UploadCmd {
                                sub: Option<String>,
                                path: Option<String>,
                                name: Option<String>,
                                size: Option<u64>,
                            }
                            if let Ok(uc) = serde_json::from_str::<UploadCmd>(&text) {
                                match uc.sub.as_deref() {
                                    Some("start") => {
                                        let path = uc.path.unwrap_or_default();
                                        let name = uc.name.unwrap_or_default();
                                        let size = uc.size.unwrap_or(0);
                                        let full_path = if path.is_empty() {
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
                                                        eprintln!("Failed to create directory {}: {}", path, e);
                                                        let _ = ack_tx.try_send(Message::Text(
                                                            r#"{"action":"upload","sub":"error"}"#.into()
                                                        ));
                                                        continue;
                                                    }
                                                }
                                                Err(_) => {
                                                    if let Err(e) = std::fs::create_dir_all(&path) {
                                                        eprintln!("Failed to create directory {}: {}", path, e);
                                                        let _ = ack_tx.try_send(Message::Text(
                                                            r#"{"action":"upload","sub":"error"}"#.into()
                                                        ));
                                                        continue;
                                                    }
                                                }
                                            }
                                        }
                                        match std::fs::File::create(&full_path) {
                                            Ok(file) => {
                                                let mut us = UPLOAD_STATE_V2.lock().unwrap();
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
                                                eprintln!("Failed to create file {}: {}", full_path, e);
                                                let _ = ack_tx.try_send(Message::Text(
                                                    r#"{"action":"upload","sub":"error"}"#.into()
                                                ));
                                            }
                                        }
                                    }
                                    Some("done") => {
                                        let path_opt = {
                                            let mut us = UPLOAD_STATE_V2.lock().unwrap();
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
                                        let mut us = UPLOAD_STATE_V2.lock().unwrap();
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
                        _ => {}
                    }
                }
                }
                _ => {}
            }
        }

        // Release all pressed keys on disconnect
        let pressed = PRESSED_KEYS.lock().unwrap().drain().collect::<Vec<_>>();
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
    });

    // === 优化2: 预分配可复用 buffer，避免高频 malloc ===
    let mut block_buffer: Vec<u8> = Vec::with_capacity(grid_size * grid_size * 4);
    let mut downsample_buffer: Vec<u8> = Vec::with_capacity(screen_w * screen_h); // (w/2 * h/2 * 4)

    // === 核心优化: 将繁重的 CPU 捕获和压缩剥离到独立的 OS 线程 ===
    // 这样就不会阻塞 Tokio 的异步网络 I/O（WebSocket 读写可以极速响应）
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut prev_frame_hash: u64 = 0;
        let mut last_cursor_type: u8 = 0;
        let mut last_sent_frame_time = std::time::Instant::now();
        let mut last_successful_capture_time = std::time::Instant::now();
        let mut consecutive_none_count: u32 = 0;
        let mut frames_since_start: u64 = 0;
        const FORCE_KEYFRAME_TIMEOUT_SECS: u64 = 5;
        const HARD_FREEZE_TIMEOUT_SECS: u64 = 30;
        const STUCK_CAPTURE_THRESHOLD: u32 = 300;
        const WARMUP_CAPTURE_FRAMES: u64 = 150;
        loop {
            if !CONNECTED.load(Ordering::Relaxed) {
                break;
            }
            if CAPTURE_PAUSED.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }

            let frame_start = std::time::Instant::now();
            let cursor_type = get_current_cursor_type();
            // 光标类型变化时，立即通过独立 0x0A 消息发送（不依赖视频帧）
            if cursor_type != last_cursor_type {
                last_cursor_type = cursor_type;
                let cursor_msg = vec![0x0Au8, cursor_type];
                let _ = tx.try_send(Message::Binary(cursor_msg));
            }
            frames_since_start += 1;

            match capturer.capture_frame() {
                Ok(frame_data) => {
                    // 成功捕获到帧：更新时间戳并清零 None 计数器
                    last_successful_capture_time = std::time::Instant::now();
                    consecutive_none_count = 0;
                    dxgi_error_count = 0;
                    // === xxhash64 全帧哈希静态帧跳过 ===
                    // 画面无变化时跳过编码/发送全部流程，大幅降低 CPU/带宽
                    let frame_hash = xxh64(&frame_data, 0);
                    if frame_hash == prev_frame_hash {
                        // 检查是否过了强制关键帧超时时间 - 防止 DXGI 返回陈旧数据导致的永久卡死
                        let elapsed_since_sent = last_sent_frame_time.elapsed().as_secs();
                        if elapsed_since_sent >= FORCE_KEYFRAME_TIMEOUT_SECS {
                            eprintln!("[Agent] WARNING: Force keyframe triggered - no frame sent for {}s", elapsed_since_sent);
                            // 重置哈希，强制发送这一帧
                            prev_frame_hash = 0;
                            // 不 continue，继续执行编码和发送
                        } else {
                            // 静态帧：等 33ms 后再检查（避免空转）
                            std::thread::sleep(std::time::Duration::from_millis(33));
                            continue;
                        }
                    }
                    prev_frame_hash = frame_hash;

                    let (dirty_blocks, change_ratio) = grid_mgr.detect_dirty_blocks(&frame_data);

                    // === 优化3: 从 AtomicU32 读取节流后的 CPU 负载 ===
                    let cpu_load = CPU_LOAD.load(Ordering::Relaxed) as f32 / 10.0;

                    let is_video = !first_frame && change_ratio > 0.50;
                    let _is_static = change_ratio < 0.02;
                    let force_key = quality_engine.need_keyframe();
                    first_frame = false;

                    // === 应用前端画质档位 ===
                    // 在 adapt() 之前设置 min/max，让自动引擎在档位范围内动态调节
                    let profile = QUALITY_PROFILE.load(Ordering::Relaxed);
                    match profile {
                        30 => { // 流畅
                            quality_engine.min_quality = 40;
                            quality_engine.max_quality = 55;
                        }
                        75 => { // 高清
                            quality_engine.min_quality = 80;
                            quality_engine.max_quality = 95;
                        }
                        _ => { // 50=均衡（默认）
                            quality_engine.min_quality = 60;
                            quality_engine.max_quality = 75;
                        }
                    }
                    quality_engine.quality = quality_engine.quality.clamp(
                        quality_engine.min_quality, quality_engine.max_quality);

                    compressor.set_quality(quality_engine.quality);
                    compressor.set_subsamp(if is_video { turbojpeg::Subsamp::Sub2x2 } else { turbojpeg::Subsamp::None });

                    let mut frame_send_bytes = 0usize;
                    let mut encode_total_ms = 0u64;
                    let mut network_dropped = false;

                    if is_video || force_key || (dirty_blocks.len() as f32) > (grid_mgr.last_hashes.len() as f32 * 0.45) {
                        // 全帧模式
                        let encode_start = std::time::Instant::now();
                        
                        let jpeg_result = if is_video {
                            // 降采样 1/2，大幅降低 CPU 开销
                            downsample_bgra_2x(&frame_data, screen_w, screen_h, &mut downsample_buffer);
                            compressor.compress_to_vec(Image {
                                pixels: &downsample_buffer, 
                                width: screen_w / 2, 
                                height: screen_h / 2, 
                                pitch: (screen_w / 2) * 4, 
                                format: PixelFormat::BGRA,
                            })
                        } else {
                            compressor.compress_to_vec(Image {
                                pixels: &frame_data, width: screen_w, height: screen_h, pitch: screen_w * 4, format: PixelFormat::BGRA,
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
                        let merged = grid_mgr.merge_connected_components(&dirty_blocks);
                        for block in &merged {
                            // 优化2: 复用 block_buffer，clear + 原地覆写
                            extract_block_rgba_into(&frame_data, block, screen_w, &mut block_buffer);
                            let encode_start = std::time::Instant::now();
                            if let Ok(jpeg_bytes) = compressor.compress_to_vec(Image {
                                pixels: &block_buffer,
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
                        grid_mgr.last_hashes.fill(0);
                    }

                    // 带宽统计
                    let now = std::time::Instant::now();
                    send_history.push_back((now, frame_send_bytes));
                    while send_history.front().map_or(false, |(t, _)| now.duration_since(*t).as_millis() > 1000) {
                        send_history.pop_front();
                    }
                    let send_kbps = send_history.iter().map(|(_, b)| b).sum::<usize>() as f32 / 1024.0;
                    quality_engine.adapt(change_ratio, cpu_load, encode_total_ms, send_kbps);

                    if status_log_timer.elapsed().as_secs() >= 5 {
                        quality_engine.log_status();
                        println!("  CPU={:.0}% change={:.1}% blocks={} send={:.0}KB/s",
                            cpu_load, change_ratio * 100.0, dirty_blocks.len(), send_kbps);
                        status_log_timer = std::time::Instant::now();
                    }
                }
                Err(CaptureError::WouldBlock) => {
                    consecutive_none_count += 1;

                    // 截屏器健康检查：连续 WouldBlock 超过阈值则断开重连
                    // 预热期内不计数，避免新连接刚建立时的短暂 WouldBlock 误触发重连
                    if frames_since_start > WARMUP_CAPTURE_FRAMES
                        && consecutive_none_count >= STUCK_CAPTURE_THRESHOLD
                    {
                        eprintln!("[Agent] WARNING: Reinitializing screen capturer after {} consecutive WouldBlock ({} frames since start)",
                            consecutive_none_count, frames_since_start);
                        CONNECTED.store(false, Ordering::Relaxed);
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        break;
                    }
                }
                Err(CaptureError::DxgiError(desc)) => {
                    dxgi_error_count += 1;
                    eprintln!("[Capture] DXGI error #{}: {}", dxgi_error_count, desc);
                }
                Err(CaptureError::GdiError) | Err(CaptureError::NoData) => {
                    consecutive_none_count += 1;
                }
            }

            // 硬冻结检测：距离上次成功捕获超过阈值则断开重连
            let freeze_elapsed = last_successful_capture_time.elapsed().as_secs();
            if freeze_elapsed >= HARD_FREEZE_TIMEOUT_SECS {
                eprintln!("[Agent] ERROR: Hard freeze detected - no frame captured for {}s, reconnecting", freeze_elapsed);
                CONNECTED.store(false, Ordering::Relaxed);
                break;
            }

            let elapsed_ms = frame_start.elapsed().as_millis() as u64;
            // 固定 33ms 帧间隔（约 30fps），替代动态 framerate 调节
            // 静态画面通过 xxhash64 跳过，动态画面保证稳定帧率
            if elapsed_ms < 33 {
                std::thread::sleep(std::time::Duration::from_millis(33 - elapsed_ms));
            }
        }
        }));
        if result.is_err() {
            eprintln!("[VideoThread] panic caught, reconnecting");
            CONNECTED.store(false, Ordering::Relaxed);
        }
    });

    // 等待：收到 ctrl_c 退出程序，或检测到连接断开则重连
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("Agent shutting down...");
            break;
        }
        _ = async {
            while CONNECTED.load(Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        } => {
            let jitter = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() % 1000) as u64;
            println!("[Reconnect] Connection lost, will reconnect after {}s...", retry_delay);
            retry_delay = (retry_delay * 2).min(60).max(1) + (jitter % std::cmp::min(retry_delay * 1000, 5000)) / 1000;
            continue;
        }
    }
    }
}
