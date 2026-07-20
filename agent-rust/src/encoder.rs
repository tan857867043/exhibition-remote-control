use crate::dirty_rect::DirtyBlock;

// 简单的降采样，由于原始数据通常是 BGRA 格式，我们需要抽取像素
pub fn downscale_frame(frame: &[u8], width: usize, height: usize, factor: usize) -> Vec<u8> {
    let new_width = width / factor;
    let new_height = height / factor;
    let mut low_res = Vec::with_capacity(new_width * new_height * 4);

    for y in 0..new_height {
        for x in 0..new_width {
            let src_x = x * factor;
            let src_y = y * factor;
            let src_idx = (src_y * width + src_x) * 4;
            
            if src_idx + 4 <= frame.len() {
                low_res.extend_from_slice(&frame[src_idx..src_idx + 4]);
            } else {
                low_res.extend_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
    low_res
}

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
