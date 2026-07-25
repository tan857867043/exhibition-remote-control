use crate::dirty_rect::DirtyBlock;

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

/// 兼容旧接口（全帧模式仍需分配，因为尺寸可能变化）
pub fn extract_block_rgba(frame: &[u8], block: &DirtyBlock, screen_width: usize) -> Vec<u8> {
    let mut block_data = Vec::with_capacity((block.w as usize) * (block.h as usize) * 4);
    extract_block_rgba_into(frame, block, screen_width, &mut block_data);
    block_data
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

