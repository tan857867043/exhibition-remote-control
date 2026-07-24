# Tasks

## P0 紧急修复（不改架构，立刻生效）

- [x] Task 1: 引入 xxhash64 全帧静态帧跳过
  - [x] SubTask 1.1: Cargo.toml 添加 `xxhash-rust = "0.8"`（features = ["xxh64"]）
  - [x] SubTask 1.2: main.rs capture 循环中计算全帧 xxhash64
  - [x] SubTask 1.3: hash 未变化时 `continue` 跳过整套编码传输

- [x] Task 2: 实现画面活跃度自动切换双模式（增量 ↔ 视频全帧）
  - [x] SubTask 2.1: CaptureMode enum + 滑动窗口（最近 3 帧）
  - [x] SubTask 2.2: ≥25% 连续 3 帧 → 视频全帧模式（降采样 1/2 + JPEG 全帧，关闭网格拆分）
  - [x] SubTask 2.3: <15% → 增量模式（网格脏矩形 + 小块 BGRA）
  - [x] SubTask 2.4: 15%~25% → 平衡模式

- [x] Task 3: 拆分 keyframe/delta 双 MPSC 通道
  - [x] SubTask 3.1: 创建 text_tx/delta_tx/keyframe_tx 三通道
  - [x] SubTask 3.2: 视频全帧走 keyframe_tx，增量块走 delta_tx
  - [x] SubTask 3.3: tokio::select!（biased）按优先级监听

## P1 捕获 & 编码优化

- [x] Task 4: DXGI + GDI 双捕获回退
  - [x] SubTask 4.1: capture_screen_gdi 函数（GDI BitBlt）
  - [x] SubTask 4.2: scrap → GDI 运行时回退 + 初始化回退
  - [x] SubTask 4.3: 基础分辨率捕获（待扩展 `--width/--height`）

- [x] Task 5: TurboJPEG 视频模式编码参数优化（在 Task 2 中顺带实现）
  - [x] SubTask 5.1: 视频全帧模式强制 quality=65 + Sub2x2 (4:2:0)
  - [x] SubTask 5.2: fast_dct（turbojpeg 默认已启用）
  - [x] SubTask 5.3: 质量 Q=65

- [x] Task 6: 帧内脏块 2ms 聚合批量发包
  - [x] SubTask 6.1: encoder.rs 增加 BatchAggregator 结构体
  - [x] SubTask 6.2: 2ms 定时器 + build_batch_packet_v2 打包

- [x] Task 7: Go 服务 + Rust Agent 关闭 Nagle 算法
  - [x] SubTask 7.1: server-go/router.go SetNoDelay(true) 两处
  - [x] SubTask 7.2: agent-rust/main.rs set_nodelay(true)

## P2 前端渲染优化（待迭代）

- [ ] Task 8: OffscreenCanvas + WebWorker 离屏渲染
- [ ] Task 9: 视频全帧模式专用渲染分支

## P3 中长期架构升级（待迭代）

- [ ] Task 10: WebRTC P2P 直连

# 实际执行顺序
```
P0（Task 1 ∥ Task 2 ∥ Task 3）→ 已全部完成 ✓
    ↓
P1（Task 4 ∥ Task 5 ∥ Task 6 ∥ Task 7）→ 已全部完成 ✓
    ↓
P2（Task 8 → Task 9）→ 后续迭代
    ↓
P3（Task 10）→ 后续迭代
```
