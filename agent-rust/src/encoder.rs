use crate::dirty_rect::DirtyBlock;
use std::time::Instant;

/// 提取脏块的 BGRA 像素数据到外部传入的可复用 buffer（原地覆写，避免高频 malloc）
/// 越界行填充黑色（安全兜底），保证 buffer 长度始终 = block.w * block.h * 4
pub fn extract_block_rgba_into(
    frame: &[u8],
    block: &DirtyBlock,
    screen_width: usize,
    out: &mut Vec<u8>,
) {
    out.clear();
    let row_bytes = (block.w as usize) * 4;
    let needed = row_bytes * (block.h as usize);
    if out.capacity() < needed {
        out.reserve(needed - out.capacity());
    }
    for row in 0..block.h as usize {
        let y = block.y as usize + row;
        let x = block.x as usize;
        let start = (y * screen_width + x) * 4;
        let end = start + row_bytes;
        if end <= frame.len() {
            out.extend_from_slice(&frame[start..end]);
        } else {
            // 越界行填充黑色 BGRA (0,0,0,255)，保证 buffer 尺寸始终正确
            out.resize(out.len() + row_bytes, 0);
            // 把 alpha 通道设为 255
            for i in (out.len() - row_bytes + 3..out.len()).step_by(4) {
                out[i] = 255;
            }
        }
    }
}

#[allow(dead_code)]
pub fn extract_block_rgba(frame: &[u8], block: &DirtyBlock, screen_width: usize) -> Vec<u8> {
    let mut block_data = Vec::with_capacity((block.w as usize) * (block.h as usize) * 4);
    extract_block_rgba_into(frame, block, screen_width, &mut block_data);
    block_data
}

/// 构建批量块包（旧版 v1，所有块均为 JPEG 编码）
/// 格式: [0x01][block_count:2 BE][block1: x(2)+y(2)+w(2)+h(2)+jpeg_len(2)+jpeg_data]...
#[allow(dead_code)]
pub fn build_batch_packet(
    blocks: &[(u16, u16, u16, u16, &[u8])],
) -> Vec<u8> {
    let mut total = 3; // type(1) + count(2)
    for &(_, _, _, _, jpeg) in blocks {
        total += 8 + jpeg.len(); // x(2)+y(2)+w(2)+h(2)+jpeg_len(2) + jpeg
    }
    let mut packet = Vec::with_capacity(total);
    packet.push(0x01);
    packet.extend_from_slice(&(blocks.len() as u16).to_be_bytes());
    for &(x, y, w, h, jpeg) in blocks {
        packet.extend_from_slice(&x.to_be_bytes());
        packet.extend_from_slice(&y.to_be_bytes());
        packet.extend_from_slice(&w.to_be_bytes());
        packet.extend_from_slice(&h.to_be_bytes());
        packet.extend_from_slice(&(jpeg.len() as u16).to_be_bytes());
        packet.extend_from_slice(jpeg);
    }
    packet
}

/// 构建批量块包 v2（支持每块独立编码类型）
/// 格式: [0x01][block_count:2 BE][block1: x(2)+y(2)+w(2)+h(2)+encoding(1)+data_len(2)+data]...
/// encoding: 0=JPEG, 1=BGRA raw
pub fn build_batch_packet_v2(
    blocks: &[(u16, u16, u16, u16, u8, &[u8])],
) -> Vec<u8> {
    let mut total = 3; // type(1) + count(2)
    for &(_, _, _, _, _, data) in blocks {
        total += 9 + data.len(); // x(2)+y(2)+w(2)+h(2)+encoding(1)+data_len(2) + data
    }
    let mut packet = Vec::with_capacity(total);
    packet.push(0x01);
    packet.extend_from_slice(&(blocks.len() as u16).to_be_bytes());
    for &(x, y, w, h, encoding, data) in blocks {
        packet.extend_from_slice(&x.to_be_bytes());
        packet.extend_from_slice(&y.to_be_bytes());
        packet.extend_from_slice(&w.to_be_bytes());
        packet.extend_from_slice(&h.to_be_bytes());
        packet.push(encoding);
        packet.extend_from_slice(&(data.len() as u16).to_be_bytes());
        packet.extend_from_slice(data);
    }
    packet
}

pub fn build_binary_packet(
    frame_type: u8,
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    jpeg_bytes: &[u8],
) -> Vec<u8> {
    let mut packet = Vec::with_capacity(9 + jpeg_bytes.len());
    packet.push(frame_type);
    packet.extend_from_slice(&x.to_be_bytes());
    packet.extend_from_slice(&y.to_be_bytes());
    packet.extend_from_slice(&w.to_be_bytes());
    packet.extend_from_slice(&h.to_be_bytes());
    packet.extend_from_slice(jpeg_bytes);
    packet
}

/// 极致性能的最近邻降采样（降至 1/2 分辨率）
/// 专用于视频播放等高动态画面，CPU 和带宽高达 4 倍优化
pub fn downsample_bgra_2x(
    frame: &[u8],
    orig_w: usize,
    orig_h: usize,
    out: &mut Vec<u8>,
) {
    let new_w = orig_w / 2;
    let new_h = orig_h / 2;
    let needed = new_w * new_h * 4;
    out.clear();
    if out.capacity() < needed {
        out.reserve(needed - out.capacity());
    }
    // Resize with uninitialized or 0, but since we are pushing, we can just use push/extend.
    // Or we can pre-allocate using resize.
    out.resize(needed, 0);
    
    let mut dst_idx = 0;
    for y in 0..new_h {
        let src_y = y * 2;
        let mut src_idx = src_y * orig_w * 4;
        for _x in 0..new_w {
            // copy 4 bytes (BGRA)
            out[dst_idx] = frame[src_idx];
            out[dst_idx + 1] = frame[src_idx + 1];
            out[dst_idx + 2] = frame[src_idx + 2];
            out[dst_idx + 3] = frame[src_idx + 3];
            
            dst_idx += 4;
            src_idx += 8; // skip 1 pixel horizontally
        }
    }
}

/// 脏块聚合器：收集脏块后在指定时间窗口内统一打包为批量消息
#[allow(dead_code)]
pub struct BatchAggregator {
    blocks: Vec<(u16, u16, u16, u16, u8, Vec<u8>)>,
    last_flush: Instant,
    flush_interval_ms: u64,
}

#[allow(dead_code)]
impl BatchAggregator {
    pub fn new(flush_interval_ms: u64) -> Self {
        Self {
            blocks: Vec::with_capacity(64),
            last_flush: Instant::now(),
            flush_interval_ms,
        }
    }

    /// 添加一个脏块到聚合队列
    pub fn push(&mut self, x: u16, y: u16, w: u16, h: u16, encoding: u8, data: Vec<u8>) {
        self.blocks.push((x, y, w, h, encoding, data));
    }

    /// 检查是否到达聚合发送时机
    /// 返回 Some(packet) 表示需要发送，None 表示继续聚合
    pub fn try_flush(&mut self) -> Option<Vec<u8>> {
        if self.blocks.is_empty() {
            return None;
        }
        let elapsed = self.last_flush.elapsed().as_millis() as u64;
        if elapsed >= self.flush_interval_ms {
            let refs: Vec<(u16, u16, u16, u16, u8, &[u8])> = self.blocks.iter()
                .map(|(x, y, w, h, enc, data)| (*x, *y, *w, *h, *enc, data.as_slice()))
                .collect();
            let packet = build_batch_packet_v2(&refs);
            self.blocks.clear();
            self.last_flush = Instant::now();
            Some(packet)
        } else {
            None
        }
    }

    /// 强制刷新（用于帧结束或断开前）
    pub fn force_flush(&mut self) -> Option<Vec<u8>> {
        if self.blocks.is_empty() {
            return None;
        }
        let refs: Vec<(u16, u16, u16, u16, u8, &[u8])> = self.blocks.iter()
            .map(|(x, y, w, h, enc, data)| (*x, *y, *w, *h, *enc, data.as_slice()))
            .collect();
        let packet = build_batch_packet_v2(&refs);
        self.blocks.clear();
        self.last_flush = Instant::now();
        Some(packet)
    }

    /// 当前缓存的脏块数量
    pub fn len(&self) -> usize {
        self.blocks.len()
    }
}

