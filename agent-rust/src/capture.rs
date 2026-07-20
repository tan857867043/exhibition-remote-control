use scrap::{Capturer, Display};

pub struct ScreenCapturer {
    pub capturer: Capturer,
    pub width: usize,
    pub height: usize,
}

impl ScreenCapturer {
    pub fn new() -> Self {
        let display = Display::primary().expect("找不到主显示器");
        let width = display.width();
        let height = display.height();
        let capturer = Capturer::new(display).expect("无法创建屏幕捕获器");
        
        Self { capturer, width, height }
    }

    pub fn capture_frame(&mut self) -> Option<Vec<u8>> {
        match self.capturer.frame() {
            Ok(frame) => {
                let mut data = vec![0; frame.len()];
                data.copy_from_slice(&frame);
                Some(data)
            }
            Err(error) => {
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    None
                } else {
                    panic!("抓取屏幕错误: {}", error);
                }
            }
        }
    }
}
