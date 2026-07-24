use scrap::{Capturer, Display};
use winapi::um::wingdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW,
    DeleteDC, DeleteObject, GetDIBits, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use winapi::um::winuser::GetSystemMetrics;
// HDC and HBITMAP are used implicitly via winapi function calls
use std::ptr;

/// 尝试 GDI 屏幕捕获（作为 scrap DXGI 的后备方案）
unsafe fn capture_screen_gdi(width: u32, height: u32) -> Option<Vec<u8>> {
    let hdc_screen = CreateDCW(ptr::null(), ptr::null(), ptr::null(), ptr::null());
    if hdc_screen.is_null() {
        return None;
    }

    let hdc_mem = CreateCompatibleDC(hdc_screen);
    if hdc_mem.is_null() {
        DeleteDC(hdc_screen);
        return None;
    }

    let hbmp = CreateCompatibleBitmap(hdc_screen, width as i32, height as i32);
    if hbmp.is_null() {
        DeleteDC(hdc_mem);
        DeleteDC(hdc_screen);
        return None;
    }

    SelectObject(hdc_mem, hbmp as *mut _);
    BitBlt(hdc_mem, 0, 0, width as i32, height as i32, hdc_screen, 0, 0, SRCCOPY);

    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width as i32;
    bmi.bmiHeader.biHeight = -(height as i32); // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    let row_pitch = ((width * 32 + 31) / 32 * 4) as usize;
    let size = row_pitch * height as usize;
    let mut buf = vec![0u8; size];

    GetDIBits(
        hdc_mem,
        hbmp,
        0,
        height as u32,
        buf.as_mut_ptr() as *mut _,
        &mut bmi,
        DIB_RGB_COLORS,
    );

    DeleteObject(hbmp as *mut _);
    DeleteDC(hdc_mem);
    DeleteDC(hdc_screen);

    Some(buf)
}

pub struct ScreenCapturer {
    pub capturer: Option<Capturer>,
    pub width: usize,
    pub height: usize,
    pub using_gdi: bool,
}

impl ScreenCapturer {
    pub fn new() -> Self {
        // 尝试初始化 scrap (DXGI)
        let (capturer, width, height, using_gdi) = match Display::primary() {
            Ok(display) => {
                let w = display.width();
                let h = display.height();
                match Capturer::new(display) {
                    Ok(cap) => (Some(cap), w, h, false),
                    Err(e) => {
                        println!("WARNING: scrap初始化失败 ({}), 回退到GDI捕获", e);
                        (None, w, h, true)
                    }
                }
            }
            Err(_) => {
                // 获取屏幕尺寸（GDI方式）
                let w = unsafe { GetSystemMetrics(0) as usize }; // SM_CXSCREEN
                let h = unsafe { GetSystemMetrics(1) as usize }; // SM_CYSCREEN
                println!("WARNING: Display::primary()失败, 回退到GDI捕获 ({}x{})", w, h);
                (None, w, h, true)
            }
        };

        Self { capturer, width, height, using_gdi }
    }

    pub fn capture_frame(&mut self) -> Option<Vec<u8>> {
        if self.using_gdi {
            // GDI 捕获
            unsafe {
                capture_screen_gdi(self.width as u32, self.height as u32)
            }
        } else if let Some(ref mut cap) = self.capturer {
            // DXGI (scrap) 捕获
            match cap.frame() {
                Ok(frame) => {
                    let mut data = vec![0; frame.len()];
                    data.copy_from_slice(&frame);
                    Some(data)
                }
                Err(error) => {
                    if error.kind() == std::io::ErrorKind::WouldBlock {
                        None
                    } else {
                        // scrap 出错时尝试回退到 GDI
                        println!("WARNING: scrap捕获失败 ({}), 切换到GDI模式", error);
                        self.using_gdi = true;
                        unsafe { capture_screen_gdi(self.width as u32, self.height as u32) }
                    }
                }
            }
        } else {
            None
        }
    }
}
