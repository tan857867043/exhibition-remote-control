## P0 紧急修复

- [x] Task 1: xxhash64 静态帧跳过
  - [x] Cargo.toml 已添加 xxhash-rust 依赖（line 17）
  - [x] capture 循环中实现了全帧哈希比较（line 408-416）
  - [x] hash 未变化时跳过编码/传输
- [x] Task 2: 画面活跃度自动切换双模式
  - [x] CaptureMode enum + 脏区域占比滑动窗口（最近 3 帧）
  - [x] ≥25% → 视频全帧模式（降采样 + JPEG 全帧，关网格拆分）
  - [x] <15% → 增量模式（网格 + BGRA 小块）
  - [x] 15%~25% → 平衡模式
- [x] Task 3: 双 MPSC 通道
  - [x] keyframe_tx / delta_tx / text_tx 三个独立通道
  - [x] 视频全帧走 keyframe_tx，增量块走 delta_tx
  - [x] tokio::select!（biased）同时监听三通道

## P1 捕获 & 编码

- [x] Task 4: GDI 双路回退
  - [x] capture_screen_gdi 函数已实现（capture.rs）
  - [x] scrap 失败时自动回退 GDI（runtime 和 init 两个层面）
  - [x] xxi 待添加（已在 task 中计划）
- [x] Task 5: TurboJPEG 视频编码参数
  - [x] 视频模式强制 quality=65 + Sub2x2 (4:2:0)
  - [x] fast_dct（turbojpeg 默认已启用）
- [x] Task 6: 脏块 2ms 聚合
  - [x] BatchAggregator 结构体已实现（encoder.rs）
  - [x] 2ms 聚合 + batch_packet_v2 打包
- [x] Task 7: Nagle 关闭
  - [x] server-go router.go SetNoDelay(true) 两处
  - [x] agent-rust main.rs set_nodelay(true)

## P2 前端渲染（后续迭代）

- [ ] Task 8: OffscreenCanvas + WebWorker
- [ ] Task 9: 视频模式专用渲染分支

## P3 架构升级（后续迭代）

- [ ] Task 10: WebRTC P2P 直连
