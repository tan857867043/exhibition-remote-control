# 竞品对标优化 Spec

## 对比分析

### 当前项目 vs 业界方案

| 维度 | 本项目 | RustDesk | TightVNC | 差距分析 |
|------|--------|----------|----------|---------|
| **编码格式** | 仅 JPEG (turbojpeg) | VP8/VP9/H.264/H.265 (硬解) | Tight (JPEG+Zlib+PNG 组合) | JPEG 对 UI/文字区域压缩率差，无法硬解 |
| **增量编码** | JPEG 增量块 (64x64 grid + BFS merge) | 视频编码器 I/P 帧 + 增量块 | Tile + 动态算法选择 | 视频编码器 I/P 帧比 JPEG 块高效得多 |
| **光标处理** | 随帧发送（无单独通道） | 无特殊处理（同画面） | **Cursor Pseudo-Encoding**（独立叠加层） | 光标随帧发送导致每次移动都要重绘帧 |
| **客户端渲染** | createImageBitmap + drawImage (CPU) | 硬件视频解码 + GPU 渲染 | 客户端软件渲染 | 无 GPU 加速 |
| **WebSocket** | 基于 HTTP 中转 | 自有 UDP/TCP 协议 | 直接 TCP 直连 | 中转增加延迟 |
| **首帧下发** | 全帧 JPEG | VP8/VP9 关键帧 | Raw/Tight 全屏 | 差距不大 |

### 核心差距：Cursor Pseudo-Encoding（光标伪编码）

VNC 的 **Cursor Pseudo-Encoding** 机制：服务器单独发送光标形状（小 PNG + 掩码），客户端在本地叠加光标。这样：
- 光标移动时**不需要发送全帧**或增量块，只需发送光标位置（6 字节）
- 画面更新时不需要包含光标区域，节约大量脏块
- 客户端显示无延迟、无撕裂

### 核心差距：增量块编码格式

当前：每个增量块是 JPEG 编码 → 客户端 `createImageBitmap` decode
- 编码快（turbojpeg）但解码慢（createImageBitmap + Blob）
- 小块 (64x64) JPEG 压缩率差，开销占比高

业界方案：
- TightVNC：对小块用 **Zlib 无损压缩**（文字区域）或 **JPEG**（照片区域）
- RustDesk：直接用**视频编码**处理全帧

## What Changes

1. **Cursor Pseudo-Encoding**：光标从画面中剥离，作为独立叠加层发送
   - Agent 侧：捕获光标形状 → PNG 压缩 → 发送一次；光标移动只发 4 字节坐标
   - 客户端侧：离屏 canvas 上叠加光标，本地响应渲染
2. **增量块小区域用原始 BGRA 直传（替代 JPEG）**
   - 当块面积 < 128x128 时，发 raw BGRA（16KB/块），客户端用 `putImageData` 直接渲染
   - 省去 JPEG 编解码耗时
3. **叠加之前的优化**（rAF 渲染队列 + 帧淘汰 + 统计降频）

## Impact

- Affected code:
  - Agent: `agent-rust/src/main.rs`（光标捕获 + 增量块编码逻辑）
  - Agent: `agent-rust/src/encoder.rs`（新增 BGRA 包构建函数）
  - Client: `src/lib/ExhibitionRemoteClient.js`（光标叠加层 + BGRA 渲染 + rAF 队列）
- 向后兼容：消息格式升级，旧客户端无法解析新格式

## ADDED Requirements

### Requirement: Cursor Pseudo-Encoding

#### Scenario: 光标形状发送

- **WHEN** 光标类型变化（如 arrow→text→hand）
- **THEN** Agent 发送光标形状消息（PNG + 热点坐标），客户端保存
- **AND** 后续光标位置变化只发 4 字节坐标

#### Scenario: 光标位置更新

- **WHEN** 鼠标在 agent 端移动
- **AND** 光标形状未变
- **THEN** 只发送光标坐标（4 字节），客户端在叠加层渲染

#### Scenario: 光标叠加渲染

- **WHEN** 客户端收到新帧（全帧或增量）
- **AND** 光标叠加层存在
- **THEN** 先在离屏 canvas 渲染画面，再将光标 PNG 按热点坐标绘制到离屏 canvas
- **AND** 一次性 blit 到显示 canvas

### Requirement: 增量块 BGRA 直传

#### Scenario: 小面积增量块

- **WHEN** 脏块合并后面积 < 128x128 像素
- **THEN** Agent 发送原始 BGRA 像素数据（不 JPEG 编码）
- **AND** 客户端用 `putImageData` 直接渲染到离屏 canvas

#### Scenario: 大面积增量块

- **WHEN** 脏块合并后面积 >= 128x128
- **THEN** 保持 JPEG 编码（大量数据下 JPEG 压缩率有意义）

### Requirement: rAF 渲染队列 + 帧淘汰

（同 `optimize-frontend-fps/spec.md`）

## MODIFIED Requirements

### Requirement: 增量编码路径（原实现）

- 原实现：所有增量块一律 JPEG 编码，客户端 `createImageBitmap` 解码
- 改为：小面积块（< 128x128）用 raw BGRA，大面积块用 JPEG

## REMOVED Requirements

### Requirement: 内置光标传输

**Reason**: 光标伪编码替代，节省带宽和脏块区域
**Migration**: 新增光标通道消息类型
