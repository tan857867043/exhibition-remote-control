# Tasks

- [ ] Task 1: ExhibitionRemoteClient 渲染队列改造
  - 添加 `renderQueue` 数组和 `rAF_id` 属性
  - WebSocket onmessage 解码 bitmap 后推入队列，不直接 drawImage
  - 帧淘汰：推入前检查队列是否已有待渲染帧，有则替换
  - rAF 循环：从队列取 bitmap → drawImage → bitmap.close → 继续下一帧

- [ ] Task 2: App.tsx 统计信息降频
  - FPS/KB/s/分辨率定时器从 1 秒改为 2 秒
  - 保持 blockCounter 更新频率不变（仅影响显示）

# Task Dependencies

- 无依赖关系
