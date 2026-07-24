# Tasks

- [x] Task 1: Agent 端光标伪编码（Cursor Pseudo-Encoding）
  - main.rs 中添加光标捕获逻辑：每次帧循环检查光标位置
  - 每帧发送光标位置消息 0x07（5字节）
  - 光标类型变化时发送形状消息 0x08
  - encoder.rs 中添加 `build_cursor_packet` 函数（内联在 main.rs 中处理）

- [x] Task 2: Agent 端增量块 BGRA 直传
  - encoder.rs 中添加 `build_batch_packet_v2` 函数（支持 per-block encoding 标志）
  - main.rs 增量路径中：块面积 < 128x128 用 BGRA raw，≥ 128x128 用 JPEG
  - 编译验证通过，0 warnings

- [x] Task 3: 客户端光标叠加层
  - ExhibitionRemoteClient.js 添加 cursorX/cursorY/cursorType 状态
  - 解析 0x07 更新光标位置，0x08 更新光标类型
  - canvas.style.cursor = 'none'，离屏 canvas 渲染后在光标位置画圆点

- [x] Task 4: 客户端 BGRA 增量块渲染
  - 批量消息解析改为 v2 格式（11 字节 header/block）
  - encoding=1 用 `putImageData` 直渲染，encoding=0 用 `createImageBitmap`
  - JPEG 块保持 4 并发批量解码

- [x] Task 5: 客户端 rAF 渲染队列 + 帧淘汰
  - 添加 pendingRender/rAFId 属性
  - onmessage 解码后不立即 drawImage，设 pendingRender=true
  - rAF 循环消费 pendingRender，渲染最新帧

- [x] Task 6: App.tsx 统计信息降频
  - fpsTimer/dataRateTimer/blockTimer 从 1000ms 改为 2000ms

# Task Dependencies

- Task 1 和 Task 3 互相关联（消息格式必须一致） ✅
- Task 5 和 Task 6 独立，可并行 ✅
- Task 3 必须在 Task 1 之后实施 ✅
