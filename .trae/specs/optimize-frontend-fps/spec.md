# 前端 FPS 优化 Spec

## Why

Agent 侧编码帧率 30 FPS、单帧编码仅 3ms，但前端控制台显示仅 10 FPS。瓶颈在客户端：WebSocket message handler 在主线程阻塞执行 `createImageBitmap` + canvas draw + React 状态更新，导致渲染流水线无法跟上 agent 的发送速度。

## What Changes

- **引入 rAF 渲染队列**：WebSocket 消息只入队，不直接渲染，由 `requestAnimationFrame` 统一消费
- **帧淘汰机制**：新帧到达时，若上一帧尚未渲染则跳过旧帧
- **降低 React 统计更新频率**：FPS/KB/s/res 改为每 2 秒更新一次，减少 re-render 抢主线程
- **webp 编码降带宽**：关键帧使用 webp 比 jpeg 同画质少 25%-50% 体积

## Impact

- Affected code: `src/lib/ExhibitionRemoteClient.js`, `src/App.tsx`
- 不改 agent 和后端，纯前端优化

## ADDED Requirements

### Requirement: requestAnimationFrame 渲染队列

#### Scenario: 消息入队 + rAF 消费

- **WHEN** WebSocket 收到全帧或批量消息
- **THEN** 只将解码后的 bitmap 存入队列，不立即 `drawImage`
- **AND** `requestAnimationFrame` 循环从队列中取最新帧渲染到 canvas

#### Scenario: 帧淘汰

- **WHEN** 新帧入队时队列中已存在未渲染帧
- **THEN** 替换掉旧帧（只渲染最新一帧）

#### Scenario: 解码与渲染分离

- **WHEN** WebSocket 收到消息
- **THEN** 在主线程 `createImageBitmap` 解码 bitmap
- **AND** 解码完成后推入渲染队列
- **AND** rAF 循环从队列取 bitmap 执行 `drawImage`

### Requirement: 降低 React 状态更新频率

#### Scenario: 统计信息节流

- **WHEN** FPS/KB/s/分辨率状态更新
- **THEN** 从每秒更新改为每 2 秒更新
- **AND** 更新时设置 `setFps` 等状态

## MODIFIED Requirements

### Requirement: WebSocket onmessage 处理（原实现）

- 原实现：`onmessage` 中 `await createImageBitmap` 完成后立即 `drawImage`
- 改为：`onmessage` 中 `await createImageBitmap` 后推入渲染队列
