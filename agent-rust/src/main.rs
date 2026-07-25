mod dirty_rect;
mod capture;
mod encoder;

use capture::ScreenCapturer;
use dirty_rect::GridManager;
use encoder::{build_binary_packet, extract_block_rgba_into, downsample_bgra_2x};
use enigo::{Enigo, MouseControllable, MouseButton, KeyboardControllable, Key};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use sysinfo::System;
use tokio_tungstenite::tungstenite::Message;
use turbojpeg::{Compressor, Image, PixelFormat};

// 全局 CPU 负载（由独立监控任务定期刷新，避免主循环高频 sysinfo 开销）
static CPU_LOAD: AtomicU32 = AtomicU32::new(0);

#[derive(Deserialize, Debug)]
struct ControlCmd {
    device_id: String,
    action: String,
    x: Option<i32>,
    y: Option<i32>,
    button: Option<String>,
    key: Option<String>,
    key_code: Option<u16>,
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
            quality: 75,
            min_quality: 30,
            max_quality: 95,
            framerate: 30,
            keyframe_interval: 60,
            frame_count: 0,
            target_rate_kbps: 50000.0,
            avg_encode_ms: 0.0,
            avg_send_kbps: 0.0,
        }
    }

    fn adapt(&mut self, change_ratio: f32, cpu_load: f32, encode_ms: u64, send_kbps: f32) {
        self.frame_count += 1;

        self.avg_encode_ms = self.avg_encode_ms * 0.7 + encode_ms as f32 * 0.3;
        self.avg_send_kbps = self.avg_send_kbps * 0.7 + send_kbps * 0.3;

        // 动态帧率与画质权衡 (视频模式保帧率降画质，静态模式保画质降帧率)
        if change_ratio > 0.40 {
            // 大面积变化 (视频播放)：降低最高帧率至 30 FPS 以保护 CPU，画质保持及格线
            self.framerate = 30;
            self.quality = (self.quality - 8).max(50);
        } else if change_ratio > 0.15 {
            self.framerate = 20;
            self.quality = (self.quality - 3).max(65);
        } else if change_ratio > 0.02 {
            self.framerate = 15;
            self.quality = (self.quality + 2).min(80);
        } else {
            // 静态画面 (文本阅读)：极低帧率，最高画质 (完美清晰)
            self.framerate = 5;
            self.quality = (self.quality + 5).min(self.max_quality);
        }

        // 带宽熔断（优先级最高）
        if send_kbps > self.target_rate_kbps * 0.85 {
            self.framerate = self.framerate.min(8);
            self.quality = (self.quality - 12).max(self.min_quality);
        } else if send_kbps > self.target_rate_kbps * 0.6 {
            self.framerate = self.framerate.min(15);
            self.quality = (self.quality - 6).max(self.min_quality);
        }

        // CPU 熔断
        if cpu_load > 80.0 {
            self.framerate = self.framerate.min(8);
            self.quality = (self.quality - 10).max(self.min_quality);
        } else if cpu_load > 60.0 {
            self.framerate = self.framerate.min(15);
            self.quality = (self.quality - 5).max(self.min_quality);
        }

        // 编码耗时调整
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

        // 防御性兜底：绝不出现 framerate=0 导致除零 panic
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

fn map_key(key_str: &str) -> Option<Key> {
    match key_str {
        "Enter" => Some(Key::Return),
        "Tab" => Some(Key::Tab),
        " " | "Space" => Some(Key::Space),
        "Backspace" => Some(Key::Backspace),
        "Escape" => Some(Key::Escape),
        "Delete" => Some(Key::Delete),
        "Insert" => Some(Key::Insert),
        "Home" => Some(Key::Home),
        "End" => Some(Key::End),
        "PageUp" => Some(Key::PageUp),
        "PageDown" => Some(Key::PageDown),
        "ArrowUp" => Some(Key::UpArrow),
        "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow),
        "ArrowRight" => Some(Key::RightArrow),
        "Shift" => Some(Key::Shift),
        "Control" => Some(Key::Control),
        "Alt" => Some(Key::Alt),
        "Meta" | "OS" => Some(Key::Meta),
        "CapsLock" => Some(Key::CapsLock),
        s if s.len() == 1 => Some(Key::Layout(s.chars().next().unwrap())),
        "F1" => Some(Key::F1), "F2" => Some(Key::F2), "F3" => Some(Key::F3),
        "F4" => Some(Key::F4), "F5" => Some(Key::F5), "F6" => Some(Key::F6),
        "F7" => Some(Key::F7), "F8" => Some(Key::F8), "F9" => Some(Key::F9),
        "F10" => Some(Key::F10), "F11" => Some(Key::F11), "F12" => Some(Key::F12),
        _ => None,
    }
}

/// 计算 CPU 平均使用率
fn cpus_avg(sys: &System) -> f32 {
    let cpus = sys.cpus();
    if cpus.is_empty() { 0.0 } else {
        cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    println!("Exhibition Agent starting (industry-grade pipeline)...");

    let mut capturer = ScreenCapturer::new();
    let screen_w = capturer.width;
    let screen_h = capturer.height;
    let grid_size = 64;

    let mut grid_mgr = GridManager::new(screen_w, screen_h, grid_size);
    let mut compressor = Compressor::new().unwrap();
    let mut quality_engine = QualityEngine::new();

    let mut send_history: VecDeque<(std::time::Instant, usize)> = VecDeque::new();
    let mut status_log_timer = std::time::Instant::now();
    let mut first_frame = true;

    // Generate or load Device ID
    let device_id = std::fs::read_to_string(".device_id").unwrap_or_else(|_| {
        let mut sys = System::new_all();
        sys.refresh_all();
        let host = System::host_name().unwrap_or_else(|| "UnknownHost".to_string());
        let new_id = format!("{}_{}_{}", host, std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        // Simple hash to make it look like an ID
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
    let networks = sysinfo::Networks::new_with_sysinfo();
    for (name, data) in &networks {
        if name != "lo" && !name.starts_with("Loopback") {
            mac_addr = format!("{:?}", data.mac_address());
            break;
        }
    }

    // URL encode strings
    let host_name_encoded = host_name.replace(" ", "%20");
    let os_name_encoded = os_name.replace(" ", "%20");
    let cpu_brand_encoded = cpu_brand.replace(" ", "%20");
    let mac_encoded = mac_addr.replace(" ", "%20");

    let url = format!("ws://127.0.0.1:38921/agent/register?device_id={}&device_name={}&os={}&cpu={}&ram={}GB&mac={}", 
        device_id, host_name_encoded, os_name_encoded, cpu_brand_encoded, mem_gb, mac_encoded);

    println!("Connecting to hub at {}", url);
    let (ws_stream, _) = tokio_tungstenite::connect_async(url).await.expect("Failed to connect");
    let (mut write, mut read) = ws_stream.split();

    // === 优化1: MPSC 通道解耦网络发送 ===
    // 容量 8192：防止高频增量块溢出导致画面撕裂
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(8192);

    // 专用异步发送任务
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
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

    // 控制命令处理（当前 current_thread 下 enigo 是 Send-safe 的；
    // 若未来改多线程 Runtime，需改为 spawn_local + LocalSet）
    tokio::spawn(async move {
        let mut enigo = Enigo::new();
        while let Some(msg) = read.next().await {
            if let Ok(Message::Text(text)) = msg {
                if let Ok(cmd) = serde_json::from_str::<ControlCmd>(&text) {
                    match cmd.action.as_str() {
                        "mouse_move" => {
                            if let (Some(x), Some(y)) = (cmd.x, cmd.y) {
                                enigo.mouse_move_to(x, y);
                            }
                        }
                        "mouse_down" => {
                            match cmd.button.as_deref() {
                                Some("left") => enigo.mouse_down(MouseButton::Left),
                                Some("right") => enigo.mouse_down(MouseButton::Right),
                                Some("middle") => enigo.mouse_down(MouseButton::Middle),
                                _ => {}
                            }
                        }
                        "mouse_up" => {
                            match cmd.button.as_deref() {
                                Some("left") => enigo.mouse_up(MouseButton::Left),
                                Some("right") => enigo.mouse_up(MouseButton::Right),
                                Some("middle") => enigo.mouse_up(MouseButton::Middle),
                                _ => {}
                            }
                        }
                        "mouse_click" => {
                            if let (Some(x), Some(y)) = (cmd.x, cmd.y) {
                                enigo.mouse_move_to(x, y);
                            }
                            match cmd.button.as_deref() {
                                Some("left") => enigo.mouse_click(MouseButton::Left),
                                Some("right") => enigo.mouse_click(MouseButton::Right),
                                Some("middle") => enigo.mouse_click(MouseButton::Middle),
                                _ => enigo.mouse_click(MouseButton::Left),
                            }
                        }
                        "mouse_wheel" => {
                            if let Some(delta) = cmd.y {
                                enigo.mouse_scroll_y(delta);
                            }
                        }
                        "key_press" => {
                            if let Some(ref key_str) = cmd.key {
                                if let Some(key) = map_key(key_str) {
                                    enigo.key_down(key);
                                }
                            }
                        }
                        "key_release" => {
                            if let Some(ref key_str) = cmd.key {
                                if let Some(key) = map_key(key_str) {
                                    enigo.key_up(key);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    // === 优化2: 预分配可复用 buffer，避免高频 malloc ===
    let mut block_buffer: Vec<u8> = Vec::with_capacity(grid_size * grid_size * 4);
    let mut downsample_buffer: Vec<u8> = Vec::with_capacity(screen_w * screen_h); // (w/2 * h/2 * 4)

    // === 核心优化: 将繁重的 CPU 捕获和压缩剥离到独立的 OS 线程 ===
    // 这样就不会阻塞 Tokio 的异步网络 I/O（WebSocket 读写可以极速响应）
    std::thread::spawn(move || {
        // 主循环：捕获→检测→自适应→编码→非阻塞发送
        loop {
            let frame_start = std::time::Instant::now();

            if let Some(frame_data) = capturer.capture_frame() {
                let (dirty_blocks, change_ratio) = grid_mgr.detect_dirty_blocks(&frame_data);

                // === 优化3: 从 AtomicU32 读取节流后的 CPU 负载 ===
                let cpu_load = CPU_LOAD.load(Ordering::Relaxed) as f32 / 10.0;

                let is_video = !first_frame && change_ratio > 0.50;
                let _is_static = change_ratio < 0.02;
                let force_key = quality_engine.need_keyframe();
                first_frame = false;

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
                            build_binary_packet(frame_flag, 0, 0, screen_w as u16, screen_h as u16, &jpeg_bytes)
                        )).is_err() {
                            network_dropped = true;
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
                                build_binary_packet(0x01, block.x, block.y, block.w, block.h, &jpeg_bytes)
                            )).is_err() {
                                network_dropped = true;
                                break;
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

            let elapsed_ms = frame_start.elapsed().as_millis() as u64;
            let target_ms = 1000 / quality_engine.framerate;
            if elapsed_ms < target_ms {
                // 因为在独立线程中，这里用标准的 std::thread::sleep 即可
                std::thread::sleep(std::time::Duration::from_millis(target_ms - elapsed_ms));
            }
        }
    });

    // 阻塞主线程，保持 Tokio 运行时存活
    tokio::signal::ctrl_c().await.unwrap();
    println!("Agent shutting down...");
}
