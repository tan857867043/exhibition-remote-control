use scrap::{Capturer, Display};

/// GDI BitBlt 截图器（DXGI 回退方案）
#[cfg(windows)]
pub struct GDICapturer {
    hwnd_dc: windows::Win32::Graphics::Gdi::HDC,
    mem_dc: windows::Win32::Graphics::Gdi::HDC,
    hbitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    pub width: usize,
    pub height: usize,
}

#[cfg(windows)]
impl GDICapturer {
    pub fn new() -> Option<Self> {
        use windows::Win32::Graphics::Gdi::*;
        unsafe {
            let hwnd_dc = GetDC(None);
            if hwnd_dc.is_invalid() {
                return None;
            }
            let mem_dc = CreateCompatibleDC(hwnd_dc);
            if mem_dc.is_invalid() {
                let _ = ReleaseDC(None, hwnd_dc);
                return None;
            }
            let width = GetDeviceCaps(hwnd_dc, HORZRES) as usize;
            let height = GetDeviceCaps(hwnd_dc, VERTRES) as usize;
            if width == 0 || height == 0 {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, hwnd_dc);
                return None;
            }
            let hbitmap = CreateCompatibleBitmap(hwnd_dc, width as i32, height as i32);
            if hbitmap.is_invalid() {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, hwnd_dc);
                return None;
            }
            let _ = SelectObject(mem_dc, hbitmap);
            Some(Self { hwnd_dc, mem_dc, hbitmap, width, height })
        }
    }

    pub fn capture_frame(&mut self) -> Option<Vec<u8>> {
        use windows::Win32::Graphics::Gdi::*;
        unsafe {
            let _ = BitBlt(self.mem_dc, 0, 0, self.width as i32, self.height as i32,
                self.hwnd_dc, 0, 0, SRCCOPY);

            let mut bmi = std::mem::zeroed::<BITMAPINFO>();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = self.width as i32;
            bmi.bmiHeader.biHeight = -(self.height as i32); // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;

            let row_size = self.width * 4;
            let total_size = row_size * self.height;
            let mut data = vec![0u8; total_size];

            let result = GetDIBits(self.mem_dc, self.hbitmap, 0, self.height as u32,
                Some(data.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);

            if result == 0 {
                return None;
            }

            // 转换 BGRA 中的 A 通道为 255（GetDIBits 可能返回 0 alpha）
            for pixel in data.chunks_exact_mut(4) {
                pixel[3] = 255;
            }

            Some(data)
        }
    }
}

#[cfg(windows)]
impl Drop for GDICapturer {
    fn drop(&mut self) {
        use windows::Win32::Graphics::Gdi::*;
        unsafe {
            let _ = DeleteObject(self.hbitmap);
            let _ = DeleteDC(self.mem_dc);
            let _ = ReleaseDC(None, self.hwnd_dc);
        }
    }
}

/// 截图方法枚举
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CaptureMethod {
    DXGI,
    GDI,
}

/// 统一的截图错误类型
#[derive(Debug)]
pub enum CaptureError {
    WouldBlock,
    DxgiError(String),
    GdiError,
    NoData,
}

/// DXGI 截图器
pub struct ScreenCapturer {
    pub capturer: Capturer,
    pub width: usize,
    pub height: usize,
}

unsafe impl Send for ScreenCapturer {}

impl ScreenCapturer {
    pub fn new() -> Result<Self, String> {
        let display_result = Display::primary();
        let display = match display_result {
            Ok(d) => d,
            Err(e) => return Err(format!("No primary display: {}", e)),
        };
        let width = display.width();
        let height = display.height();
        match Capturer::new(display) {
            Ok(capturer) => Ok(Self { capturer, width, height }),
            Err(e) => Err(format!("Cannot create DXGI capturer: {}", e)),
        }
    }

    pub fn capture_frame(&mut self) -> Result<Vec<u8>, CaptureError> {
        match self.capturer.frame() {
            Ok(frame) => {
                let mut data = vec![0; frame.len()];
                data.copy_from_slice(&frame);
                Ok(data)
            }
            Err(error) => {
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    Err(CaptureError::WouldBlock)
                } else {
                    Err(CaptureError::DxgiError(error.to_string()))
                }
            }
        }
    }
}

/// 统一的捕获结果
#[derive(Debug)]
pub enum CaptureResult {
    /// DXGI 正在使用中
    Dxgi { data: Vec<u8>, width: usize, height: usize },
    /// GDI 正在使用中
    Gdi { data: Vec<u8>, width: usize, height: usize },
}
