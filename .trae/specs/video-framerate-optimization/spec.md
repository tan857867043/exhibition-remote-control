# 视频场景帧率优化 Spec

## Why

当前主项目在展厅静态UI场景表现优秀（~30 FPS），但在播放视频等高动态画面时帧率骤降至个位数。核心瓶颈：海量64px脏矩形小块在编码、传输、渲染各环节阻塞流水线，以及缺少高动态场景专用快速路径。

## 分析结论

通过 D 副本对比 + 用户提供的瓶颈定位方法，视频场景帧率不足的根因分层：

| 层级 | 根因 | 影响程度 |
|------|------|---------|
| Agent 捕获 | 无静态帧哈希跳过，静止画面也持续计算 | 高（浪费 80%+ CPU） |
| Agent 编码 | 视频场景仍走 64px 网格拆小块，海量 JPEG 编码 + TCP 小包 | 最高 |
| Agent 传输 | keyframe/delta 共用单 MPSC 通道，争抢队列 | 高 |
| 网络拓扑 | WS → Go → WS 两跳 TCP 转发，队头阻塞 | 中（P2 解决） |
| 前端渲染 | 大量增量块 putImageData 阻塞 rAF | 中 |

## 改造原则

- **P0**: 不改架构，纯 Agent 参数/逻辑调整，立刻见效
- **P1**: Agent 编码流程重构 + 网络参数优化
- **P2**: 前端渲染优化
- **P3**: 中长期架构升级（WebRTC P2P）

## P0 紧急修复（不改架构，立刻提升视频场景帧率）

### Requirement: 全帧 xxhash64 静态帧跳过

**引入 D 副本已验证的机制**：Agent 捕获完整 BGRA 后先算全局 hash。

- **WHEN** 当前帧 hash == 上一帧 hash
- **THEN** 直接丢弃，跳过脏矩形检测、编码、传输全流程
- **WHEN** hash 变化
- **THEN** 进入后续脏矩形/编码逻辑

效果：UI 静止场景减少 90% 无效计算，CPU 资源释放给视频编码。

### Requirement: 画面活跃度自动切换双模式

主项目已有 1/2 降采样能力但未自动利用。新增判定逻辑：

- **WHEN** 脏区域比例连续 3 帧 ≥ 25%
- **THEN** 进入**视频全帧模式**：
  - 关闭 64px 网格脏矩形拆分
  - 直接降采样 1/2 + JPEG 全帧（4:2:0, fast_dct, Q=60~70）
  - 锁定最大 30 FPS，队列满丢旧帧
- **WHEN** 脏区域比例 < 15%
- **THEN** 切回增量脏矩形模式（小块 BGRA 直传）
- **WHEN** 15%~25%
- **THEN** 平衡模式，适度合并脏块

### Requirement: 拆分 keyframe/delta 双 MPSC 通道

借鉴 D 副本 reduce-latency spec：

- 通道 A：增量脏矩形流（静态/低动态画面）
- 通道 B：关键全帧流（视频模式、首次连接、大幅跳转）
- 两条队列独立消费，视频全帧不阻塞增量画面
- tokio::select! 同时监听，关键帧优先发送

## P1 捕获 & 编码底层优化

### Requirement: DXGI + GDI 双捕获回退

- **WHEN** scrap DXGI 初始化失败
- **THEN** 自动回退 GDI BitBlt 截屏，避免黑屏断流
- 保证老旧工控机/特殊显示器视频捕获稳定

### Requirement: TurboJPEG 视频模式编码参数

视频全帧模式强制：
- 4:2:0 色度采样（chroma subsampling）
- fast_dct 极速 DCT
- 关闭无损优化（huffman optimization off）
- 质量 Q=60~70

### Requirement: 帧内脏块内存聚合 2ms 窗口

当前每个脏块计算完立即发包 → 海量 TCP 小包 → Nagle 延迟 + 队头阻塞。

- 增加 2ms 聚合窗口
- 单帧所有脏块打包为一条 WS Binary 消息
- 消除 TCP 小包 N agle 合并延迟

### Requirement: Go 服务 + Rust Agent 关闭 Nagle 算法

- Go gorilla/websocket: `conn.SetNoDelay(true)`
- Rust tokio-tungstenite: `Socket::set_nodelay(true)`
- 小包立即发送，视频流无堆积延迟

## P2 前端渲染优化

### Requirement: OffscreenCanvas + WebWorker 离屏渲染

- JPEG 解码、BGRA putImageData 移出 React UI 主线程
- 主线程仅做最终 Canvas 合成
- 避免大量增量块渲染阻塞 requestAnimationFrame

### Requirement: 视频模式专用渲染分支

- **WHEN** 收到全帧数据包（0x02/0x04）
- **THEN** 直接覆盖整张画布，跳过批量小块 putImageData 循环
- 减少上千次绘图调用

### Requirement: 帧淘汰严格执行

- Go 服务每个订阅者缓冲通道 cap=16
- **WHEN** 通道满
- **THEN** 丢弃最旧帧，只推送最新画面
- 不等待慢帧堆积延迟

## P3 中长期架构升级

### Requirement: WebRTC P2P 直连（替代 TCP 两跳中转）

当前 `前端 — WS — Go — WS — Agent` 是视频大流量天花板。

- Go 服务降级为纯信令服务：设备注册、鉴权、SDP 交换、键鼠指令
- 画面数据流改用 WebRTC DataChannel，Agent 与浏览器 P2P 直连
- 底层 UDP 传输，根除 TCP 队头阻塞
- 去掉 Go 中转两次二进制拷贝
- WebRTC 通道优先级：键鼠 > 视频流

## 影响范围

| 改动 | 文件 | 影响 |
|------|------|------|
| xxhash64 静态帧跳过 | agent-rust/src/main.rs, Cargo.toml | Agent 捕获循环 |
| 视频双模式 | agent-rust/src/main.rs | 编码分支逻辑 |
| 双 MPSC 通道 | agent-rust/src/main.rs | 消息队列架构 |
| GDI 回退 | agent-rust/src/main.rs / capture.rs | 捕获模块 |
| TurboJPEG 参数 | agent-rust/src/main.rs | 编码配置 |
| 帧聚合 2ms | agent-rust/src/encoder.rs | 发包逻辑 |
| Nagle 关闭 | server-go/hub/router.go, agent-rust/src/main.rs | 网络层 |
| 前端离屏渲染 | src/lib/ExhibitionRemoteClient.js | 渲染引擎 |
| WebRTC P2P | server-go + agent-rust + 前端 | 架构升级（P3） |
