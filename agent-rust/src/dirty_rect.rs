use std::collections::VecDeque;

pub struct GridManager {
    pub width: usize,
    pub height: usize,
    pub grid_size: usize,
    pub cols: usize,
    pub rows: usize,
    pub last_hashes: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct DirtyBlock {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    #[allow(dead_code)]
    pub data_offset: usize,
}

impl GridManager {
    pub fn new(width: usize, height: usize, grid_size: usize) -> Self {
        let cols = (width + grid_size - 1) / grid_size;
        let rows = (height + grid_size - 1) / grid_size;
        let total = cols * rows;
        Self {
            width,
            height,
            grid_size,
            cols,
            rows,
            last_hashes: vec![0; total],
        }
    }

    /// 高效扫描像素网格，使用 CRC32 哈希确认真实变化
    pub fn detect_dirty_blocks(&mut self, frame: &[u8]) -> (Vec<DirtyBlock>, f32) {
        let mut dirty = Vec::new();
        let mut changed_count = 0;

        for r in 0..self.rows {
            for c in 0..self.cols {
                let idx = r * self.cols + c;

                let block_x = c * self.grid_size;
                let block_y = r * self.grid_size;
                let block_w = self.grid_size.min(self.width - block_x);
                let block_h = self.grid_size.min(self.height - block_y);

                let mut hasher = crc32fast::Hasher::new();
                for row_offset in 0..block_h {
                    let pixel_y = block_y + row_offset;
                    let start_pixel = (pixel_y * self.width + block_x) * 4;
                    let row_bytes = block_w * 4;
                    if start_pixel + row_bytes <= frame.len() {
                        hasher.update(&frame[start_pixel .. start_pixel + row_bytes]);
                    }
                }

                let current_hash = hasher.finalize();
                if self.last_hashes[idx] != current_hash {
                    self.last_hashes[idx] = current_hash;
                    changed_count += 1;
                    dirty.push(DirtyBlock {
                        x: block_x as u16,
                        y: block_y as u16,
                        w: block_w as u16,
                        h: block_h as u16,
                        data_offset: idx,
                    });
                }
            }
        }

        let change_ratio = changed_count as f32 / (self.cols * self.rows) as f32;
        (dirty, change_ratio)
    }

    /// 连通分量分析 + 包围盒合并（参照 VNC/X11 Damage/RDP 标准做法）
    pub fn merge_connected_components(&self, blocks: &[DirtyBlock]) -> Vec<DirtyBlock> {
        if blocks.is_empty() {
            return vec![];
        }

        let total = self.cols * self.rows;

        let mut dirty_grid = vec![false; total];
        for b in blocks {
            let c = (b.x as usize) / self.grid_size;
            let r = (b.y as usize) / self.grid_size;
            if r < self.rows && c < self.cols {
                dirty_grid[r * self.cols + c] = true;
            }
        }

        let mut visited = vec![false; total];
        let mut result = Vec::new();
        let directions: [(isize, isize); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

        for r in 0..self.rows {
            for c in 0..self.cols {
                let idx = r * self.cols + c;
                if !dirty_grid[idx] || visited[idx] {
                    continue;
                }

                let mut min_c = c;
                let mut max_c = c;
                let mut min_r = r;
                let mut max_r = r;
                let mut queue = VecDeque::with_capacity(64);
                queue.push_back((r, c));
                visited[idx] = true;

                while let Some((cr, cc)) = queue.pop_front() {
                    for &(dr, dc) in &directions {
                        let nr = cr.wrapping_add(dr as usize);
                        let nc = cc.wrapping_add(dc as usize);
                        if nr < self.rows && nc < self.cols {
                            let nidx = nr * self.cols + nc;
                            if dirty_grid[nidx] && !visited[nidx] {
                                visited[nidx] = true;
                                queue.push_back((nr, nc));
                                if nc < min_c { min_c = nc; }
                                if nc > max_c { max_c = nc; }
                                if nr < min_r { min_r = nr; }
                                if nr > max_r { max_r = nr; }
                            }
                        }
                    }
                }

                let bx = (min_c * self.grid_size) as u16;
                let by = (min_r * self.grid_size) as u16;
                let mut bw = ((max_c + 1) * self.grid_size - min_c * self.grid_size) as u16;
                let mut bh = ((max_r + 1) * self.grid_size - min_r * self.grid_size) as u16;

                bw = bw.min((self.width - bx as usize) as u16);
                bh = bh.min((self.height - by as usize) as u16);

                if bw == 0 || bh == 0 {
                    continue;
                }

                const MCU: u16 = 16;
                bw = ((bw + MCU - 1) / MCU * MCU).min((self.width - bx as usize) as u16);
                bh = ((bh + MCU - 1) / MCU * MCU).min((self.height - by as usize) as u16);

                result.push(DirtyBlock {
                    x: bx,
                    y: by,
                    w: bw,
                    h: bh,
                    data_offset: 0,
                });
            }
        }

        result
    }
}
