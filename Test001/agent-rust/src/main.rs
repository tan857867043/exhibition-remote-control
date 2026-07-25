use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::{Duration, Instant};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use futures_util::{StreamExt, SinkExt};
use sysinfo::{System, Networks};
use windows::Win32::{
    UI::Input::KeyboardAndMouse::*,
    UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, SM_CXCURSOR, CURSORINFO, CURSORINFO_FLAGS, ICONINFO, GetCursorInfo, GetIconInfo, DrawIconEx, DI_NORMAL, HCURSOR, SetCursorPos, LoadCursorW, IDC_ARROW, IDC_IBEAM, IDC_HAND, IDC_SIZENS, IDC_SIZEWE, IDC_WAIT, IDC_CROSS, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENWSE},
    Graphics::Gdi::*,
    Foundation::*,
};
use jpeg_encoder;

const EXE_CONFIG_GUID: &[u8] = &[0xB9, 0x96, 0x01, 0x58, 0x80, 0x54, 0x4A, 0x19, 0xB7, 0xF7, 0xE9, 0xBE, 0x44, 0x91, 0x4C, 0x18];
const TILE_SIZE: usize = 64;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Config {
    server_url: String,
    device_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct ServerMsg {
    action: String,
    device_id: Option<String>,
    value: Option<i32>,
    command: Option<String>,
    cmd: Option<String>,
    timeout: Option<u64>,
    cmd_id: Option<String>,
    shot_id: Option<String>,
}

fn read_exe_config() -> Option<Config> {
    let path = std::env::current_exe().ok()?;
    let mut file = File::open(&path).ok()?;
    let metadata = file.metadata().ok()?;
    let file_size = metadata.len();
    
    if file_size < 20 { return None; }
    
    let guid_pos = file_size - 16;
    let len_pos = file_size - 20;
    
    let mut guid_buf = vec![0u8; 16];
    if file.seek(SeekFrom::Start(guid_pos)).is_err() { return None; }
    if file.read(&mut guid_buf).is_err() { return None; }
    
    if guid_buf != EXE_CONFIG_GUID { return None; }
    
    let mut len_buf = vec![0u8; 4];
    if file.seek(SeekFrom::Start(len_pos)).is_err() { return None; }
    if file.read(&mut len_buf).is_err() { return None; }
    
    let config_len = u32::from_be_bytes(len_buf.try_into().ok()?) as usize;
    if config_len == 0 || config_len > 65536 { return None; }
    
    let config_pos = len_pos - config_len as u64;
    if config_pos < 0 { return None; }
    
    let mut config_buf = vec![0u8; config_len];
    if file.seek(SeekFrom::Start(config_pos)).is_err() { return None; }
    if file.read(&mut config_buf).is_err() { return None; }
    
    let config_str = String::from_utf8_lossy(&config_buf);
    serde_json::from_str(&config_str).ok()
}

fn get_device_name() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        return name;
    }
    "Unknown".to_string()
}

fn get_local_ip() -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(std::net::SocketAddr::V4(v4)) = socket.local_addr() {
                return v4.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

// ============ Cursor Type Detection ============
static STD_CURSORS: OnceLock<[isize; 10]> = OnceLock::new();
fn init_std_cursors() -> [isize; 10] {
    unsafe {
        [
            LoadCursorW(None, IDC_ARROW).unwrap().0,
            LoadCursorW(None, IDC_IBEAM).unwrap().0,
            LoadCursorW(None, IDC_HAND).unwrap().0,
            LoadCursorW(None, IDC_SIZENS).unwrap().0,
            LoadCursorW(None, IDC_SIZEWE).unwrap().0,
            LoadCursorW(None, IDC_WAIT).unwrap().0,
            LoadCursorW(None, IDC_CROSS).unwrap().0,
            LoadCursorW(None, IDC_SIZEALL).unwrap().0,
            LoadCursorW(None, IDC_SIZENESW).unwrap().0,
            LoadCursorW(None, IDC_SIZENWSE).unwrap().0,
        ]
    }
}
fn detect_cursor_type() -> u8 {
    let cursors = STD_CURSORS.get_or_init(init_std_cursors);
    let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, flags: CURSORINFO_FLAGS(0), hCursor: HCURSOR(0), ptScreenPos: POINT { x: 0, y: 0 } };
    unsafe { let _ = GetCursorInfo(&mut ci); }
    let h = ci.hCursor.0;
    for (i, &ch) in cursors.iter().enumerate() {
        if ch == h { return i as u8; }
    }
    255 // unknown
}

// ============ Screen Capture: scrap + GDI fallback ============
fn capture_screen_scrap() -> Option<(Vec<u8>, u32, u32, usize, Vec<(u32, u32, u32, u32)>)> {
    use scrap::{Capturer, Display};
    use std::cell::RefCell;

    thread_local! {
        static CAPTURER: RefCell<Option<Capturer>> = RefCell::new(
            Display::primary().ok().and_then(|d| Capturer::new(d).ok())
        );
    }

    CAPTURER.with(|cell| {
        let mut capturer = cell.borrow_mut();
        let cap = capturer.as_mut()?;
        let w = cap.width() as u32;
        let h = cap.height() as u32;
        let frame = cap.frame().ok()?;
        let len = frame.len();
        let mut buf = vec![0u8; len];
        buf.copy_from_slice(&frame);
        Some((buf, w, h, w as usize * 4, Vec::new()))
    })
}

fn capture_screen_gdi() -> Option<(Vec<u8>, u32, u32, usize, Vec<(u32, u32, u32, u32)>)> {
    unsafe {
        let hdc = GetDC(HWND(0));
        if hdc.is_invalid() { return None; }
        
        let width = GetSystemMetrics(SM_CXSCREEN) as u32;
        let height = GetSystemMetrics(SM_CYSCREEN) as u32;
        
        let memdc = CreateCompatibleDC(hdc);
        if memdc.is_invalid() {
            ReleaseDC(HWND(0), hdc);
            return None;
        }
        
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 }; 1],
        };
        
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbmp_result = CreateDIBSection(memdc, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE(0), 0);
        if hbmp_result.is_err() || bits.is_null() {
            let _ = DeleteDC(memdc);
            ReleaseDC(HWND(0), hdc);
            return None;
        }
        let hbmp = hbmp_result.unwrap();
        
        let old = SelectObject(memdc, hbmp);
        let _ = BitBlt(memdc, 0, 0, width as i32, height as i32, hdc, 0, 0, SRCCOPY);
        SelectObject(memdc, old);
        
        let row_pitch = ((width * 32 + 31) / 32) * 4;
        let size = (row_pitch * height) as usize;
        let mut buf = vec![0u8; size];
        std::ptr::copy_nonoverlapping(bits as *mut u8, buf.as_mut_ptr(), size);
        
        let _ = DeleteObject(hbmp);
        let _ = DeleteDC(memdc);
        ReleaseDC(HWND(0), hdc);
        
        Some((buf, width, height, row_pitch as usize, Vec::new()))
    }
}

fn capture_screen() -> Option<(Vec<u8>, u32, u32, usize, Vec<(u32, u32, u32, u32)>)> {
    capture_screen_scrap().or_else(capture_screen_gdi)
}

// ============ Cursor Capture (GDI) ============
struct CursorData {
    #[allow(dead_code)]
    visible: bool,
    #[allow(dead_code)]
    x: i32,
    #[allow(dead_code)]
    y: i32,
    #[allow(dead_code)]
    hot_x: i32,
    #[allow(dead_code)]
    hot_y: i32,
    #[allow(dead_code)]
    width: u32,
    #[allow(dead_code)]
    height: u32,
    #[allow(dead_code)]
    pixels: Vec<u8>,
}

unsafe fn capture_cursor() -> Option<CursorData> {
    let mut cursor_info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        flags: CURSORINFO_FLAGS(0),
        hCursor: HCURSOR(0),
        ptScreenPos: POINT { x: 0, y: 0 },
    };
    
    if GetCursorInfo(&mut cursor_info).is_err() {
        return None;
    }
    
    let visible = cursor_info.flags != CURSORINFO_FLAGS(0);
    if !visible {
        return Some(CursorData {
            visible: false,
            x: cursor_info.ptScreenPos.x,
            y: cursor_info.ptScreenPos.y,
            hot_x: 0,
            hot_y: 0,
            width: 0,
            height: 0,
            pixels: Vec::new(),
        });
    }
    
    let h_cursor = cursor_info.hCursor;
    let x = cursor_info.ptScreenPos.x;
    let y = cursor_info.ptScreenPos.y;
    
    let mut icon_info = ICONINFO {
        fIcon: false.into(),
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: HBITMAP(0),
        hbmColor: HBITMAP(0),
    };
    
    if GetIconInfo(h_cursor, &mut icon_info).is_err() {
        return None;
    }
    
    let hot_x = icon_info.xHotspot as i32;
    let hot_y = icon_info.yHotspot as i32;
    
    let _ = DeleteObject(icon_info.hbmMask);
    let _ = DeleteObject(icon_info.hbmColor);
    
    let hdc_screen = GetDC(HWND(0));
    if hdc_screen.is_invalid() {
        return None;
    }
    
    let hdc_mem = CreateCompatibleDC(hdc_screen);
    if hdc_mem.is_invalid() {
        let _ = ReleaseDC(HWND(0), hdc_screen);
        return None;
    }
    
    let cursor_size = GetSystemMetrics(SM_CXCURSOR) as u32;
    let width = cursor_size;
    let height = cursor_size;
    
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 }; 1],
    };
    
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let h_bitmap_result = CreateDIBSection(hdc_mem, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE(0), 0);
    if h_bitmap_result.is_err() || bits.is_null() {
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(HWND(0), hdc_screen);
        return None;
    }
    let h_bitmap = h_bitmap_result.unwrap();
    
    let old_bitmap = SelectObject(hdc_mem, h_bitmap);
    
    let _ = PatBlt(hdc_mem, 0, 0, width as i32, height as i32, BLACKNESS);
    let _ = DrawIconEx(hdc_mem, 0, 0, h_cursor, width as i32, height as i32, 0, None, DI_NORMAL);
    let _ = GdiFlush();
    
    let size = (width * height * 4) as usize;
    let mut pixels = vec![0u8; size];
    std::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), size);
    
    let _ = SelectObject(hdc_mem, old_bitmap);
    let _ = DeleteObject(h_bitmap);
    let _ = DeleteDC(hdc_mem);
    let _ = ReleaseDC(HWND(0), hdc_screen);
    
    static CURSOR_ALPHA_DEBUG: AtomicBool = AtomicBool::new(false);
    if !CURSOR_ALPHA_DEBUG.swap(true, Ordering::Relaxed) {
        let o = 10 * 4;
        println!("Cursor pixel[10]: R={} G={} B={} A={}", pixels[o + 2], pixels[o + 1], pixels[o], pixels[o + 3]);
        match (0..(width * height) as usize).find(|&i| pixels[i * 4 + 3] > 0) {
            Some(i) => {
                let o = i * 4;
                println!("Cursor first alpha>0 pixel[{}]: R={} G={} B={} A={}", i, pixels[o + 2], pixels[o + 1], pixels[o], pixels[o + 3]);
            }
            None => println!("Cursor: no pixel with alpha>0 found"),
        }
    }
    
    Some(CursorData {
        visible: true,
        x,
        y,
        hot_x,
        hot_y,
        width,
        height,
        pixels,
    })
}

// ============ BGRA -> RGB Conversions ============
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "sse2")]
unsafe fn bgra_to_rgb_sse2(data: &[u8]) -> Vec<u8> {
    use std::arch::x86_64::*;
    
    let num_pixels = data.len() / 4;
    let mut result = Vec::with_capacity(num_pixels * 3);
    
    let mut i = 0usize;
    let chunk_size = 16;
    
    while i + chunk_size <= data.len() {
        let bgra = _mm_loadu_si128(data.as_ptr().add(i) as *const __m128i);
        
        let shuffle_mask = _mm_setr_epi8(
            2, 1, 0, -1,
            6, 5, 4, -1,
            10, 9, 8, -1,
            14, 13, 12, -1,
        );
        
        let rgb = _mm_shuffle_epi8(bgra, shuffle_mask);
        
        let mut tmp = [0u8; 16];
        _mm_storeu_si128(tmp.as_mut_ptr() as *mut __m128i, rgb);
        
        result.extend_from_slice(&tmp[0..3]);
        result.extend_from_slice(&tmp[4..7]);
        result.extend_from_slice(&tmp[8..11]);
        result.extend_from_slice(&tmp[12..15]);
        
        i += chunk_size;
    }
    
    while i + 3 < data.len() {
        result.extend_from_slice(&[data[i+2], data[i+1], data[i]]);
        i += 4;
    }
    
    result
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn bgra_to_rgb_avx2(data: &[u8]) -> Vec<u8> {
    use std::arch::x86_64::*;
    
    let num_pixels = data.len() / 4;
    let mut result = Vec::with_capacity(num_pixels * 3);
    
    let mut i = 0usize;
    let chunk_size = 32;
    
    while i + chunk_size <= data.len() {
        let bgra = _mm256_loadu_si256(data.as_ptr().add(i) as *const __m256i);
        
        let shuffle_mask = _mm256_setr_epi8(
            2, 1, 0, -1,
            6, 5, 4, -1,
            10, 9, 8, -1,
            14, 13, 12, -1,
            18, 17, 16, -1,
            22, 21, 20, -1,
            26, 25, 24, -1,
            30, 29, 28, -1,
        );
        
        let rgb = _mm256_shuffle_epi8(bgra, shuffle_mask);
        
        let mut tmp = [0u8; 32];
        _mm256_storeu_si256(tmp.as_mut_ptr() as *mut __m256i, rgb);
        
        result.extend_from_slice(&tmp[0..3]);
        result.extend_from_slice(&tmp[4..7]);
        result.extend_from_slice(&tmp[8..11]);
        result.extend_from_slice(&tmp[12..15]);
        result.extend_from_slice(&tmp[16..19]);
        result.extend_from_slice(&tmp[20..23]);
        result.extend_from_slice(&tmp[24..27]);
        result.extend_from_slice(&tmp[28..31]);
        
        i += chunk_size;
    }
    
    while i + 3 < data.len() {
        result.extend_from_slice(&[data[i+2], data[i+1], data[i]]);
        i += 4;
    }
    
    result
}

fn bgra_to_rgb_scalar(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len() * 3 / 4);
    let mut i = 0;
    while i + 3 < data.len() {
        result.extend_from_slice(&[data[i+2], data[i+1], data[i]]);
        i += 4;
    }
    result
}

fn bgra_to_rgb(data: &[u8]) -> Vec<u8> {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") {
            return unsafe { bgra_to_rgb_avx2(data) };
        }
        if is_x86_feature_detected!("sse2") {
            return unsafe { bgra_to_rgb_sse2(data) };
        }
    }
    bgra_to_rgb_scalar(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    fn check_bgra_to_rgb(input: &[u8], expected: &[u8]) {
        let scalar_result = bgra_to_rgb_scalar(input);
        assert_eq!(scalar_result, expected, "Scalar version mismatch");
        
        let simd_result = bgra_to_rgb(input);
        assert_eq!(simd_result, expected, "SIMD version mismatch");
        assert_eq!(simd_result, scalar_result, "SIMD and scalar versions differ");
    }
    
    #[test]
    fn test_bgra_to_rgb_single_pixel() {
        let input = [0x00, 0x11, 0x22, 0xFF];
        let expected = [0x22, 0x11, 0x00];
        check_bgra_to_rgb(&input, &expected);
    }
    
    #[test]
    fn test_bgra_to_rgb_four_pixels() {
        let input = [
            0x00, 0x11, 0x22, 0xFF,
            0x33, 0x44, 0x55, 0xFF,
            0x66, 0x77, 0x88, 0xFF,
            0x99, 0xAA, 0xBB, 0xFF,
        ];
        let expected = [
            0x22, 0x11, 0x00,
            0x55, 0x44, 0x33,
            0x88, 0x77, 0x66,
            0xBB, 0xAA, 0x99,
        ];
        check_bgra_to_rgb(&input, &expected);
    }
    
    #[test]
    fn test_bgra_to_rgb_eight_pixels() {
        let input = [
            0x00, 0x01, 0x02, 0x03,
            0x04, 0x05, 0x06, 0x07,
            0x08, 0x09, 0x0A, 0x0B,
            0x0C, 0x0D, 0x0E, 0x0F,
            0x10, 0x11, 0x12, 0x13,
            0x14, 0x15, 0x16, 0x17,
            0x18, 0x19, 0x1A, 0x1B,
            0x1C, 0x1D, 0x1E, 0x1F,
        ];
        let expected = [
            0x02, 0x01, 0x00,
            0x06, 0x05, 0x04,
            0x0A, 0x09, 0x08,
            0x0E, 0x0D, 0x0C,
            0x12, 0x11, 0x10,
            0x16, 0x15, 0x14,
            0x1A, 0x19, 0x18,
            0x1E, 0x1D, 0x1C,
        ];
        check_bgra_to_rgb(&input, &expected);
    }
    
    #[test]
    fn test_bgra_to_rgb_mixed_boundaries() {
        let input = [
            0x00, 0x00, 0xFF, 0xFF,
            0x00, 0xFF, 0x00, 0xFF,
            0xFF, 0x00, 0x00, 0xFF,
            0xFF, 0xFF, 0xFF, 0xFF,
            0x88, 0x99, 0xAA, 0xBB,
        ];
        let expected = [
            0xFF, 0x00, 0x00,
            0x00, 0xFF, 0x00,
            0x00, 0x00, 0xFF,
            0xFF, 0xFF, 0xFF,
            0xAA, 0x99, 0x88,
        ];
        check_bgra_to_rgb(&input, &expected);
    }
    
    #[test]
    fn test_bgra_to_rgb_empty() {
        check_bgra_to_rgb(&[], &[]);
    }
    
    #[test]
    fn test_bgra_to_rgb_incomplete_pixel() {
        let input = [0x00, 0x11, 0x22];
        let expected = [];
        check_bgra_to_rgb(&input, &expected);
    }
}

// ============ JPEG Encoding ============
fn encode_jpeg(data: &[u8], width: u32, height: u32, quality: i32) -> Vec<u8> {
    let quality_u8 = std::cmp::min(100, std::cmp::max(1, quality)) as u8;
    let rgb = bgra_to_rgb(data);
    match mozjpeg_rs::Encoder::new(mozjpeg_rs::Preset::BaselineFastest)
        .quality(quality_u8)
        .encode_rgb(&rgb, width, height)
    {
        Ok(buf) => buf,
        Err(_) => {
            let mut fallback_buf = Vec::new();
            let encoder = jpeg_encoder::Encoder::new(&mut fallback_buf, quality_u8);
            if encoder.encode(&rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb).is_ok() {
                fallback_buf
            } else {
                Vec::new()
            }
        }
    }
}

// ============ Tile-based Dirty Detection ============
fn find_dirty_tiles(prev: &[u8], curr: &[u8], width: u32, height: u32, row_pitch: usize) -> Vec<(u32, u32, u32, u32)> {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") {
            return unsafe { find_dirty_tiles_avx2(prev, curr, width, height, row_pitch) };
        }
        if is_x86_feature_detected!("sse2") {
            return unsafe { find_dirty_tiles_sse2(prev, curr, width, height, row_pitch) };
        }
    }
    find_dirty_tiles_scalar(prev, curr, width, height, row_pitch)
}

fn find_dirty_tiles_scalar(prev: &[u8], curr: &[u8], width: u32, height: u32, row_pitch: usize) -> Vec<(u32, u32, u32, u32)> {
    if prev.len() != curr.len() {
        return vec![(0, 0, width, height)];
    }
    
    let tile_w = (width + TILE_SIZE as u32 - 1) / TILE_SIZE as u32;
    let tile_h = (height + TILE_SIZE as u32 - 1) / TILE_SIZE as u32;
    let mut dirty = Vec::new();
    
    for ty in 0..tile_h {
        for tx in 0..tile_w {
            let x = tx * TILE_SIZE as u32;
            let y = ty * TILE_SIZE as u32;
            let tw = std::cmp::min(TILE_SIZE as u32, width - x);
            let th = std::cmp::min(TILE_SIZE as u32, height - y);
            
            let mut is_dirty = false;
            for py in 0..th {
                for px in 0..tw {
                    let idx = ((y + py) * row_pitch as u32 + (x + px) * 4) as usize;
                    if idx + 3 < prev.len() && prev[idx..idx+4] != curr[idx..idx+4] {
                        is_dirty = true;
                        break;
                    }
                }
                if is_dirty { break; }
            }
            
            if is_dirty {
                dirty.push((x, y, tw, th));
            }
        }
    }
    
    dirty
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn find_dirty_tiles_avx2(prev: &[u8], curr: &[u8], width: u32, height: u32, row_pitch: usize) -> Vec<(u32, u32, u32, u32)> {
    use std::arch::x86_64::*;
    let tile_w = (width + TILE_SIZE as u32 - 1) / TILE_SIZE as u32;
    let tile_h = (height + TILE_SIZE as u32 - 1) / TILE_SIZE as u32;
    let mut dirty = Vec::new();
    
    for ty in 0..tile_h {
        for tx in 0..tile_w {
            let x = tx * TILE_SIZE as u32;
            let y = ty * TILE_SIZE as u32;
            let tw = std::cmp::min(TILE_SIZE as u32, width - x);
            let th = std::cmp::min(TILE_SIZE as u32, height - y);
            
            let mut is_dirty = false;
            for py in 0..th as usize {
                let row_offset = ((y as usize + py) * row_pitch + x as usize * 4);
                let mut offset = 0usize;
                let row_bytes = tw as usize * 4;
                while offset + 32 <= row_bytes {
                    let a = _mm256_loadu_si256(prev[row_offset + offset..].as_ptr() as *const __m256i);
                    let b = _mm256_loadu_si256(curr[row_offset + offset..].as_ptr() as *const __m256i);
                    let cmp = _mm256_cmpeq_epi8(a, b);
                    let mask = _mm256_movemask_epi8(cmp);
                    if mask != 0xFFFFFFFFu32 as i32 {
                        is_dirty = true;
                        break;
                    }
                    offset += 32;
                }
                if is_dirty { break; }
                while offset < row_bytes {
                    if prev[row_offset + offset] != curr[row_offset + offset] {
                        is_dirty = true;
                        break;
                    }
                    offset += 1;
                }
                if is_dirty { break; }
            }
            if is_dirty {
                dirty.push((x, y, tw, th));
            }
        }
    }
    dirty
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "sse2")]
unsafe fn find_dirty_tiles_sse2(prev: &[u8], curr: &[u8], width: u32, height: u32, row_pitch: usize) -> Vec<(u32, u32, u32, u32)> {
    use std::arch::x86_64::*;
    let tile_w = (width + TILE_SIZE as u32 - 1) / TILE_SIZE as u32;
    let tile_h = (height + TILE_SIZE as u32 - 1) / TILE_SIZE as u32;
    let mut dirty = Vec::new();
    
    for ty in 0..tile_h {
        for tx in 0..tile_w {
            let x = tx * TILE_SIZE as u32;
            let y = ty * TILE_SIZE as u32;
            let tw = std::cmp::min(TILE_SIZE as u32, width - x);
            let th = std::cmp::min(TILE_SIZE as u32, height - y);
            
            let mut is_dirty = false;
            for py in 0..th as usize {
                let row_offset = ((y as usize + py) * row_pitch + x as usize * 4);
                let mut offset = 0usize;
                let row_bytes = tw as usize * 4;
                while offset + 16 <= row_bytes {
                    let a = _mm_loadu_si128(prev[row_offset + offset..].as_ptr() as *const __m128i);
                    let b = _mm_loadu_si128(curr[row_offset + offset..].as_ptr() as *const __m128i);
                    let cmp = _mm_cmpeq_epi8(a, b);
                    let mask = _mm_movemask_epi8(cmp);
                    if mask != 0xFFFFi32 {
                        is_dirty = true;
                        break;
                    }
                    offset += 16;
                }
                if is_dirty { break; }
                while offset < row_bytes {
                    if prev[row_offset + offset] != curr[row_offset + offset] {
                        is_dirty = true;
                        break;
                    }
                    offset += 1;
                }
                if is_dirty { break; }
            }
            if is_dirty {
                dirty.push((x, y, tw, th));
            }
        }
    }
    dirty
}

// ============ Connected Component Merging with MCU Alignment ============
fn merge_connected_components(
    dirty: &[(u32, u32, u32, u32)],
    tile_size: u32,
    screen_w: u32,
    screen_h: u32,
) -> Vec<(u32, u32, u32, u32)> {
    if dirty.is_empty() {
        return Vec::new();
    }

    let grid_w = ((screen_w + tile_size - 1) / tile_size) as usize;
    let grid_h = ((screen_h + tile_size - 1) / tile_size) as usize;
    let mut grid = vec![false; grid_w * grid_h];

    // Mark dirty tile positions on grid
    for &(x, y, _, _) in dirty {
        let gx = (x / tile_size) as usize;
        let gy = (y / tile_size) as usize;
        if gx < grid_w && gy < grid_h {
            grid[gy * grid_w + gx] = true;
        }
    }

    let mut visited = vec![false; grid_w * grid_h];
    let mut result = Vec::new();
    const MCU: u32 = 16;

    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = gy * grid_w + gx;
            if !grid[idx] || visited[idx] {
                continue;
            }

            // BFS to find connected component
            let mut queue = VecDeque::new();
            queue.push_back((gx, gy));
            visited[idx] = true;

            let mut min_gx = gx;
            let mut min_gy = gy;
            let mut max_gx = gx;
            let mut max_gy = gy;

            while let Some((cx, cy)) = queue.pop_front() {
                // Update bounding box
                min_gx = min_gx.min(cx);
                min_gy = min_gy.min(cy);
                max_gx = max_gx.max(cx);
                max_gy = max_gy.max(cy);

                // 4-directional neighbors
                let dirs: [(isize, isize); 4] = [(0, -1), (0, 1), (-1, 0), (1, 0)];
                for (dx, dy) in dirs {
                    let nx = cx as isize + dx;
                    let ny = cy as isize + dy;
                    if nx >= 0 && ny >= 0 && nx < grid_w as isize && ny < grid_h as isize {
                        let nidx = (ny as usize) * grid_w + (nx as usize);
                        if grid[nidx] && !visited[nidx] {
                            visited[nidx] = true;
                            queue.push_back((nx as usize, ny as usize));
                        }
                    }
                }
            }

            // Compute bounding box in pixels
            let bx = min_gx as u32 * tile_size;
            let by = min_gy as u32 * tile_size;
            let mut bw = ((max_gx - min_gx + 1) as u32) * tile_size;
            let mut bh = ((max_gy - min_gy + 1) as u32) * tile_size;

            // Clip to screen bounds
            if bx + bw > screen_w { bw = screen_w - bx; }
            if by + bh > screen_h { bh = screen_h - by; }

            // Align to JPEG MCU=16 to avoid block boundary artifacts
            bw = ((bw + MCU - 1) / MCU) * MCU;
            bh = ((bh + MCU - 1) / MCU) * MCU;

            // Re-clip after MCU alignment
            if bx + bw > screen_w { bw = screen_w - bx; }
            if by + bh > screen_h { bh = screen_h - by; }

            result.push((bx, by, bw, bh));
        }
    }

    result
}

fn calculate_dirty_ratio(dirty_area: u64, screen_area: u64) -> f32 {
    if screen_area == 0 {
        return 1.0;
    }
    dirty_area as f32 / screen_area as f32
}

fn adjust_quality(ratio: f32) -> u8 {
    if ratio < 0.05 {
        80
    } else if ratio <= 0.40 {
        60
    } else {
        50
    }
}

fn adjust_fps(ratio: f32) -> u32 {
    if ratio < 0.05 {
        40
    } else if ratio <= 0.40 {
        50
    } else {
        40
    }
}

fn build_region_data(frame_type: u8, x: u32, y: u32, w: u32, h: u32, cursor_type: u8, jpeg: &[u8]) -> Vec<u8> {
    let mut data = Vec::new();
    data.push(frame_type);
    data.extend_from_slice(&(x as u16).to_be_bytes());
    data.extend_from_slice(&(y as u16).to_be_bytes());
    data.extend_from_slice(&(w as u16).to_be_bytes());
    data.extend_from_slice(&(h as u16).to_be_bytes());
    data.extend_from_slice(&(jpeg.len() as u32).to_be_bytes());
    data.push(cursor_type);
    data.extend_from_slice(jpeg);
    data
}

fn build_kvm_message(cmd: u16, data: &[u8]) -> Vec<u8> {
    let mut msg = Vec::new();
    msg.extend_from_slice(&cmd.to_be_bytes());
    msg.extend_from_slice(&(data.len() as u16 + 4).to_be_bytes());
    msg.extend_from_slice(data);
    msg
}

fn build_screen_size_message(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&(width as u16).to_be_bytes());
    data.extend_from_slice(&(height as u16).to_be_bytes());
    build_kvm_message(7, &data)
}

unsafe fn send_input_raw(inputs: &[INPUT]) {
    SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
}

fn handle_input(data: &[u8], pressed_keys: &mut HashSet<u16>) {
    if data.len() < 6 { return; }
    
    unsafe {
        match data[0] {
            0x01 => {
                let x = ((data[3] as i32) << 8) | data[2] as i32;
                let y = ((data[5] as i32) << 8) | data[4] as i32;
                SetCursorPos(x, y);
            }
            0x02 => {
                let btn = data[1] as u32;
                let down = data[2] == 1;
                let flags = match (btn, down) {
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
                        mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                    },
                };
                send_input_raw(&[input]);
            }
            0x03 => {
                let delta = i16::from_ne_bytes([data[2], data[3]]) as i32;
                let input = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: delta as u32, dwFlags: MOUSEEVENTF_WHEEL, time: 0, dwExtraInfo: 0 },
                    },
                };
                send_input_raw(&[input]);
            }
            0x04 => {
                if data.len() > 6 {
                    let count = data[1] as usize;
                    let mut i = 2;
                    for _ in 0..count {
                        if i + 3 > data.len() { break; }
                        let action = data[i];
                        let vk = ((data[i+2] as u16) << 8) | data[i+1] as u16;
                        i += 3;
                        if action == 0 || action == 2 {
                            pressed_keys.insert(vk);
                        } else {
                            pressed_keys.remove(&vk);
                        }
                        let mut flags = KEYBD_EVENT_FLAGS(0);
                        if action >= 2 { flags |= KEYEVENTF_EXTENDEDKEY; }
                        if action == 1 || action == 3 { flags |= KEYEVENTF_KEYUP; }
                        let input = INPUT {
                            r#type: INPUT_KEYBOARD,
                            Anonymous: INPUT_0 {
                                ki: KEYBDINPUT {
                                    wVk: VIRTUAL_KEY(vk),
                                    wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0,
                                },
                            },
                        };
                        send_input_raw(&[input]);
                    }
                } else {
                    let vk = ((data[3] as u16) << 8) | data[2] as u16;
                    let action = data[1];
                    if action == 0 || action == 2 {
                        pressed_keys.insert(vk);
                    } else {
                        pressed_keys.remove(&vk);
                    }
                    
                    let mut flags = KEYBD_EVENT_FLAGS(0);
                    if action >= 2 { flags |= KEYEVENTF_EXTENDEDKEY; }
                    if action == 1 || action == 3 { flags |= KEYEVENTF_KEYUP; }
                    
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
            0x05 => {
                if data[1] == 10 {
                    for &(vk, ext) in &[(0x11, true), (0x12, true), (0x2E, true), (0x2E, false), (0x12, false), (0x11, false)] {
                        let mut flags = KEYEVENTF_EXTENDEDKEY;
                        if !ext { flags |= KEYEVENTF_KEYUP; }
                        let input = INPUT {
                            r#type: INPUT_KEYBOARD,
                            Anonymous: INPUT_0 {
                                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                            },
                        };
                        send_input_raw(&[input]);
                    }
                }
            }
            _ => {}
        }
    }
}

fn release_modifier_keys() {
    unsafe {
        for vk in [0x11u16, 0x12u16, 0x10u16, 0x5Bu16, 0x5Cu16] {
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

fn release_all_keys(pressed_keys: &HashSet<u16>) {
    release_modifier_keys();
    unsafe {
        for &vk in pressed_keys {
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

async fn handle_exec(command: &str, cmd_id: &str, tx: mpsc::Sender<WsMessage>) {
    let output = match std::process::Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-Command", command])
        .output()
    {
        Ok(o) => o,
        Err(_) => std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: Vec::new(),
            stderr: Vec::new(),
        },
    };
    
    let result = serde_json::json!({
        "action": "exec_result",
        "cmd_id": cmd_id,
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "code": output.status.code().unwrap_or(-1),
    });
    
    if let Ok(json) = serde_json::to_string(&result) {
        let _ = tx.send(WsMessage::Text(json)).await;
    }
}

async fn handle_screenshot(shot_id: &str, tx: mpsc::Sender<WsMessage>) {
    if let Some((data, w, h, _, _)) = capture_screen() {
        let jpeg = encode_jpeg(&data, w, h, 70);
        let result = serde_json::json!({
            "action": "screenshot_data",
            "shot_id": shot_id,
            "data": base64::encode_engine(&jpeg, &base64::engine::general_purpose::STANDARD),
        });
        if let Ok(json) = serde_json::to_string(&result) {
            let _ = tx.send(WsMessage::Text(json)).await;
        }
    }
}

fn is_command_blocked(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    const BLOCKED_PATTERNS: &[&str] = &[
        "format ", "format.exe", "format.com",
        "del /f", "del /s", "del /q",
        "erase /f", "erase /s", "erase /q",
        "rd /s", "rmdir /s",
        "shutdown", "shutdown.exe",
        "diskpart", "diskpart.exe",
        "reg delete",
        "regedt32",
        "regini",
        "cipher /w",
        "takeown /f",
    ];
    for pattern in BLOCKED_PATTERNS {
        if lower.contains(pattern) {
            return true;
        }
    }
    false
}

async fn handle_cmd_exec(cmd: &str, timeout_ms: u64, device_id: &str, tx: mpsc::Sender<WsMessage>) {
    let start = Instant::now();

    if is_command_blocked(cmd) {
        let cost = start.elapsed().as_millis() as u64;
        let result = serde_json::json!({
            "status": "cmd_fail",
            "device_id": device_id,
            "error": "Command blocked by safety filter",
            "cost": cost,
        });
        if let Ok(json) = serde_json::to_string(&result) {
            let _ = tx.send(WsMessage::Text(json)).await;
        }
        return;
    }

    let timeout_dur = Duration::from_millis(timeout_ms);
    let cmd_future = tokio::process::Command::new("cmd.exe")
        .args(["/C", cmd])
        .output();

    match timeout(timeout_dur, cmd_future).await {
        Ok(Ok(output)) => {
            let cost = start.elapsed().as_millis() as u64;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let combined = if stderr.is_empty() {
                stdout
            } else {
                format!("{}\n{}", stdout, stderr)
            };
            let result = serde_json::json!({
                "status": "cmd_success",
                "device_id": device_id,
                "output": combined,
                "cost": cost,
            });
            if let Ok(json) = serde_json::to_string(&result) {
                let _ = tx.send(WsMessage::Text(json)).await;
            }
        }
        Ok(Err(e)) => {
            let cost = start.elapsed().as_millis() as u64;
            let result = serde_json::json!({
                "status": "cmd_fail",
                "device_id": device_id,
                "error": format!("Execution error: {}", e),
                "cost": cost,
            });
            if let Ok(json) = serde_json::to_string(&result) {
                let _ = tx.send(WsMessage::Text(json)).await;
            }
        }
        Err(_) => {
            let result = serde_json::json!({
                "status": "cmd_fail",
                "device_id": device_id,
                "error": format!("Command timeout after {}ms", timeout_ms),
                "cost": timeout_ms,
            });
            if let Ok(json) = serde_json::to_string(&result) {
                let _ = tx.send(WsMessage::Text(json)).await;
            }
        }
    }
}

// ============ Main ============
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut server_url: Option<String> = None;
    let mut device_name: Option<String> = None;
    
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--width" => {
                i += 1;
                if i < args.len() {
                    width = args[i].parse().ok();
                }
            }
            "--height" => {
                i += 1;
                if i < args.len() {
                    height = args[i].parse().ok();
                }
            }
            "--server" => {
                i += 1;
                if i < args.len() {
                    server_url = Some(args[i].clone());
                }
            }
            "--name" => {
                i += 1;
                if i < args.len() {
                    device_name = Some(args[i].clone());
                }
            }
            _ => {}
        }
        i += 1;
    }
    
    let embedded_config = read_exe_config();
    let device_name_for_id = get_device_name();
    let device_id = std::env::var("DEVICE_ID").unwrap_or_else(|_| device_name_for_id.clone());
    
    let default_server_url = format!("ws://localhost:8080/agent/register?device_id={}", device_id);
    
    let embedded_server_url = embedded_config.as_ref().map(|c| c.server_url.clone());
    let embedded_device_name = embedded_config.as_ref().map(|c| c.device_name.clone()).flatten();
    let embedded_width = embedded_config.as_ref().map(|c| c.width).flatten();
    let embedded_height = embedded_config.as_ref().map(|c| c.height).flatten();
    
    println!("Embedded config found: {}", embedded_config.is_some());
    if let Some(ec) = &embedded_config {
        println!("  server_url: {}", ec.server_url);
        println!("  device_name: {:?}", ec.device_name);
    }
    println!("Command line server_url: {:?}", server_url);
    println!("Env SERVER_URL: {:?}", std::env::var("SERVER_URL").ok());
    
    let final_server_url = server_url.or_else(|| std::env::var("SERVER_URL").ok()).or(embedded_server_url).unwrap_or(default_server_url);
    let final_server_url = if final_server_url.contains("/agent/register") {
        final_server_url
    } else {
        format!("{}/agent/register?device_id={}", final_server_url, device_id)
    };
    
    let final_server_url = if final_server_url.starts_with("http://") {
        final_server_url.replacen("http://", "ws://", 1)
    } else if final_server_url.starts_with("https://") {
        final_server_url.replacen("https://", "wss://", 1)
    } else {
        final_server_url
    };
    
    let final_device_name = std::env::var("DEVICE_NAME").ok().or(device_name).or(embedded_device_name);
    let final_width = width.or_else(|| std::env::var("CAPTURE_WIDTH").ok().and_then(|s| s.parse().ok())).or(embedded_width);
    let final_height = height.or_else(|| std::env::var("CAPTURE_HEIGHT").ok().and_then(|s| s.parse().ok())).or(embedded_height);
    
    let config = Config {
        server_url: final_server_url,
        device_name: final_device_name,
        width: final_width,
        height: final_height,
    };
    
    if let (Some(w), Some(h)) = (config.width, config.height) {
        println!("Using custom resolution: {}x{}", w, h);
    }
    
    let _device_name = config.device_name.clone().unwrap_or_else(get_device_name);
    let _ip = get_local_ip();
    
    loop {
        println!("Connecting to {}", config.server_url);
        
        let ws_url = url::Url::parse(&config.server_url).unwrap();
        let (mut ws_stream, _) = match connect_async(ws_url).await {
            Ok(r) => r,
            Err(e) => {
                println!("Connection failed: {}, retrying in 5s", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        
        let (tx, mut rx) = mpsc::channel::<WsMessage>(100);
        let tx_clone = tx.clone();
        
        let device_name = config.device_name.clone().unwrap_or_else(get_device_name);
        let ip = get_local_ip();
        
        let info_msg = serde_json::json!({
            "action": "register",
            "name": device_name,
            "os": "Windows",
            "ip": ip,
        }).to_string();
        let _ = ws_stream.send(WsMessage::Text(info_msg)).await;
        
        release_modifier_keys();
        println!("Released modifier keys on connect");
        
        // ============ Device Telemetry Task ============
        let telemetry_tx = tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let mut sys = System::new_all();
                sys.refresh_all();

                let cpu_name = sys.cpus().first()
                    .map(|c| c.brand().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());
                let cpu_usage = if sys.cpus().is_empty() {
                    0.0
                } else {
                    // Need two samples for accurate CPU usage
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    sys.refresh_cpu_all();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    sys.refresh_cpu_all();
                    sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / sys.cpus().len() as f32
                };
                let total_ram = sys.total_memory();
                let used_ram = sys.used_memory();

                let mut mac = String::new();
                let networks = Networks::new_with_refreshed_list();
                for (name, data) in &networks {
                    if name != "lo" && !name.starts_with("Loopback") {
                        mac = format!("{:?}", data.mac_address());
                        break;
                    }
                }

                let os_name = format!("{} {}", 
                    System::name().unwrap_or_else(|| "Unknown".to_string()),
                    System::os_version().unwrap_or_default());

                let telemetry = serde_json::json!({
                    "action": "telemetry",
                    "cpu": cpu_name,
                    "cpu_usage": format!("{:.1}%", cpu_usage),
                    "ram_total": format!("{:.1}GB", total_ram as f64 / 1_073_741_824.0),
                    "ram_used": format!("{:.1}GB", used_ram as f64 / 1_073_741_824.0),
                    "mac": mac,
                    "os": os_name,
                });

                if let Ok(json) = serde_json::to_string(&telemetry) {
                    let _ = telemetry_tx.send(WsMessage::Text(json)).await;
                }
            }
        });

        let state_arc = Arc::new(Mutex::new(AgentState {
            device_id: None,
            quality: 45,
            running: true,
        }));
        let pressed_keys = Arc::new(Mutex::new(HashSet::new()));
        let state_arc_clone = Arc::clone(&state_arc);
        let pressed_keys_clone = Arc::clone(&pressed_keys);
        let pressed_keys_clone2 = Arc::clone(&pressed_keys);
        
        let prev_frame_arc = Arc::new(Mutex::new(None::<Vec<u8>>));
        let prev_hash_arc = Arc::new(Mutex::new(None::<u64>));
        let row_pitch_arc = Arc::new(Mutex::new(0usize));
        let fps_controller_arc = Arc::new(Mutex::new(FpsController::new()));

        let (keyframe_tx, mut keyframe_rx) = mpsc::channel::<Vec<u8>>(2);
        let (delta_tx, mut delta_rx) = mpsc::channel::<Vec<u8>>(6);
        let keyframe_tx_clone = keyframe_tx.clone();
        let delta_tx_clone = delta_tx.clone();

        let _screen_tx = tx.clone();
        let fps_controller_arc_clone = Arc::clone(&fps_controller_arc);
        
        let capture_width = config.width.unwrap_or(0);
        let capture_height = config.height.unwrap_or(0);
        
        let heartbeat_tx = tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                if heartbeat_tx.send(WsMessage::Text("ping".to_string())).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(async move {
            let mut frame_count: u32 = 0;
            let mut dirty_history: VecDeque<f32> = VecDeque::with_capacity(4);
            loop {
                let state = state_arc_clone.lock().await;
                if !state.running {
                    drop(state);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
                drop(state);

                {
                    let mut fc = fps_controller_arc_clone.lock().await;
                    fc.wait_frame_interval().await;
                }

                if let Some((data, w, h, actual_row_pitch, _dxgi_dirty_rects)) = capture_screen() {

                    let cursor_type = detect_cursor_type();

                    // Fast pre-check: skip tile diff on static frames using xxhash
                    {
                        let frame_hash = xxhash_rust::xxh64::xxh64(&data, 0);
                        let mut ph = prev_hash_arc.lock().await;
                        if *ph == Some(frame_hash) {
                            // Screen unchanged, no work needed
                            drop(ph);
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            continue;
                        }
                        *ph = Some(frame_hash);
                    }

                    let mut prev_frame = prev_frame_arc.lock().await;
                    let mut row_pitch = row_pitch_arc.lock().await;

                    if prev_frame.is_none() {
                        *row_pitch = actual_row_pitch;

                        let quality = state_arc_clone.lock().await.quality;
                        let jpeg = encode_jpeg(&data, w, h, quality);
                        let frame_msg = build_region_data(0x04, 0, 0, w, h, cursor_type, &jpeg);

                        println!("Sending full frame JPEG, size: {}", frame_msg.len());
                        let _ = keyframe_tx_clone.try_send(frame_msg);
                        *prev_frame = Some(data);

                        let mut fps_controller = fps_controller_arc_clone.lock().await;
                        fps_controller.update_fps();
                        drop(fps_controller);
                    } else {
                        let prev = prev_frame.as_ref().unwrap();
                        let raw_dirty = find_dirty_tiles(prev, &data, w, h, *row_pitch);

                        // === Task 1: Connected component merging with MCU alignment ===
                        let dirty = merge_connected_components(
                            &raw_dirty,
                            TILE_SIZE as u32,
                            w,
                            h,
                        );

                        if !dirty.is_empty() {
                            let dirty_area: u64 = dirty.iter().map(|(_, _, dw, dh)| *dw as u64 * *dh as u64).sum();
                            let screen_area = w as u64 * h as u64;
                            let ratio = calculate_dirty_ratio(dirty_area, screen_area);

                            dirty_history.push_back(ratio);
                            if dirty_history.len() > 3 {
                                dirty_history.pop_front();
                            }

                            let motion_degraded = dirty_history.len() == 3
                                && dirty_history.iter().all(|&r| r > 0.40);

                            if ratio <= 0.40 {
                                dirty_history.clear();
                            }

                            let base_quality = adjust_quality(ratio);
                            let quality = if motion_degraded {
                                std::cmp::max(40, base_quality.saturating_sub(10))
                            } else {
                                base_quality
                            };

                            let mut fps_controller = fps_controller_arc_clone.lock().await;
                            fps_controller.set_target_fps(adjust_fps(ratio));
                            drop(fps_controller);

                            if ratio > 0.40 || frame_count >= 15 {
                                let jpeg = encode_jpeg(&data, w, h, quality as i32);
                                if !jpeg.is_empty() {
                                    let frame_msg = build_region_data(0x04, 0, 0, w, h, cursor_type, &jpeg);
                                    let _ = keyframe_tx_clone.try_send(frame_msg);
                                }
                                frame_count = 0;
                            } else {
                                frame_count += 1;
                                let mut batch_msg = Vec::new();
                                for &(dx, dy, dw, dh) in &dirty {
                                    let mut region_data = Vec::new();
                                    for py in 0..dh {
                                        let offset = ((dy + py) * *row_pitch as u32 + dx * 4) as usize;
                                        let end = offset + (dw * 4) as usize;
                                        if end <= data.len() {
                                            region_data.extend_from_slice(&data[offset..end]);
                                        }
                                    }

                                    let jpeg = encode_jpeg(&region_data, dw, dh, quality as i32);
                                    if !jpeg.is_empty() {
                                        let frame_type = if dw == w && dh == h { 0x04 } else { 0x03 };
                                        let region_data = build_region_data(frame_type, dx, dy, dw, dh, cursor_type, &jpeg);
                                        batch_msg.extend(region_data);
                                    }
                                }

                                if !batch_msg.is_empty() {
                                    let _ = delta_tx_clone.try_send(batch_msg);
                                }
                            }

                            let mut fps_controller = fps_controller_arc_clone.lock().await;
                            fps_controller.update_fps();
                            drop(fps_controller);
                        }

                        *prev_frame = Some(data);
                    }
                    drop(prev_frame);
                    drop(row_pitch);
                } else {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        });
        
        loop {
            tokio::select! {
                biased;
                msg = ws_stream.next() => {
                    let msg = match msg {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => {
                            println!("Read error: {}", e);
                            break;
                        }
                        None => {
                            println!("Connection closed");
                            break;
                        }
                    };

                    println!("Received message: {:?}", msg);

                    match msg {
                        WsMessage::Binary(data) => {
                            if data.len() >= 4 {
                                let mut pk = pressed_keys_clone.lock().await;
                                handle_input(&data, &mut pk);
                                drop(pk);
                                if data[0] == 0x06 {
                                    let _ = tx.send(WsMessage::Binary(vec![0x07, 0, 0, 0, 0, 0])).await;
                                }
                            }
                        }
                        WsMessage::Text(text) => {
                            if text.trim() == "pong" {
                                continue;
                            }
                            if text.trim() == "ping" {
                                let _ = tx.send(WsMessage::Text("pong".to_string())).await;
                                continue;
                            }
                            if let Ok(msg) = serde_json::from_str::<ServerMsg>(&text) {
                                let mut state = state_arc.lock().await;
                                match msg.action.as_str() {
                                    "ping" => {
                                        let _ = tx.send(WsMessage::Text("pong".to_string())).await;
                                    }
                                    "registered" => {
                                        state.device_id = msg.device_id;
                                    }
                                    "desktop_start" => {
                                        println!("Received desktop_start command");
                                        release_modifier_keys();
                                        state.running = true;
                                    }
                                    "desktop_stop" => {
                                        state.running = false;
                                        let pk = pressed_keys_clone.lock().await;
                                        release_all_keys(&pk);
                                        drop(pk);
                                        pressed_keys_clone.lock().await.clear();
                                    }
                                    "quality" => {
                                        state.quality = msg.value.unwrap_or(45);
                                    }
                                    "exec" => {
                                        if let (Some(cmd), Some(cmd_id)) = (msg.command, msg.cmd_id) {
                                            let tx_clone = tx.clone();
                                            tokio::spawn(async move {
                                                handle_exec(&cmd, &cmd_id, tx_clone).await;
                                            });
                                        }
                                    }
                                    "screenshot" => {
                                        if let Some(shot_id) = msg.shot_id {
                                            let tx_clone = tx.clone();
                                            tokio::spawn(async move {
                                                handle_screenshot(&shot_id, tx_clone).await;
                                            });
                                        }
                                    }
                                    "cmd_exec" => {
                                        if let Some(cmd) = msg.cmd.clone() {
                                            let timeout_ms = msg.timeout.unwrap_or(5000);
                                            let device_id = state.device_id.clone().unwrap_or_default();
                                            let tx_clone = tx.clone();
                                            tokio::spawn(async move {
                                                handle_cmd_exec(&cmd, timeout_ms, &device_id, tx_clone).await;
                                            });
                                        }
                                    }
                                    _ => {}
                                }
                                drop(state);
                            }
                        }
                        WsMessage::Close(_) => {
                            break;
                        }
                        _ => {}
                    }
                }
                keyframe = keyframe_rx.recv() => {
                    match keyframe {
                        Some(data) => { if ws_stream.send(WsMessage::Binary(data)).await.is_err() { break; } }
                        None => break,
                    }
                }
                delta = delta_rx.recv() => {
                    match delta {
                        Some(data) => { if ws_stream.send(WsMessage::Binary(data)).await.is_err() { break; } }
                        None => break,
                    }
                }
                msg = rx.recv() => {
                    if let Some(msg) = msg {
                        if ws_stream.send(msg).await.is_err() {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
        
        let mut state = state_arc.lock().await;
        state.running = false;
        drop(state);
        let pk = pressed_keys_clone2.lock().await;
        release_all_keys(&pk);
        drop(pk);
        pressed_keys_clone2.lock().await.clear();
        
        println!("Disconnected, retrying in 5s");
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

struct AgentState {
    device_id: Option<String>,
    quality: i32,
    running: bool,
}

struct FpsController {
    frame_count: u32,
    last_fps_update: Instant,
    current_fps: f32,
    last_frame_time: Instant,
    target_fps: u32,
}

impl FpsController {
    fn new() -> Self {
        FpsController {
            frame_count: 0,
            last_fps_update: Instant::now(),
            current_fps: 0.0,
            last_frame_time: Instant::now(),
            target_fps: 30,
        }
    }

    fn update_fps(&mut self) {
        self.frame_count += 1;
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_fps_update).as_secs_f32();
        
        if elapsed >= 1.0 {
            self.current_fps = self.frame_count as f32 / elapsed;
            self.frame_count = 0;
            self.last_fps_update = now;
            println!("Current FPS: {:.1}", self.current_fps);
        }
    }

    fn set_target_fps(&mut self, fps: u32) {
        self.target_fps = fps;
    }

    #[allow(dead_code)]
    fn get_target_fps(&self) -> u32 {
        self.target_fps
    }

    #[allow(dead_code)]
    fn get_current_fps(&self) -> f32 {
        self.current_fps
    }

    async fn wait_frame_interval(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_frame_time);
        let target_interval = Duration::from_secs(1) / self.target_fps;

        if elapsed < target_interval {
            tokio::time::sleep(target_interval - elapsed).await;
        }

        self.last_frame_time = Instant::now();
    }
}
