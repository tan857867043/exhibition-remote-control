# Tasks

- [ ] Task 1: 集成副本项目的 xxhash64 静态帧跳过到主项目 agent-rust
  - SubTask 1.1: 在 Cargo.toml 添加 xxhash-rust 依赖
  - SubTask 1.2: 在 capture 流程添加全帧哈希比较，无变化时跳过后续处理
  - SubTask 1.3: 合并 CRC32 块哈希（从副本的 GridManager 风格移植，与主项目的 CRC32 结合）

- [ ] Task 2: 将副本项目的 scrap + GDI 双路回退捕获机制引入主项目
  - SubTask 2.1: 创建 GDI 回退函数（capture_screen_gdi、CreateDIBSection、BitBlt）
  - SubTask 2.2: 修改 capture_screen 为 scrap → GDI 回退链路
  - SubTask 2.3: 添加自定义分辨率支持（`--width` `--height` 参数，传递给 scrap/GDI）

- [ ] Task 3: 引入 keyframe/delta 分离 mpsc 通道（从副本的 reduce-latency spec 借鉴）
  - SubTask 3.1: 创建 keyframe_tx/delta_tx 双通道
  - SubTask 3.2: 修改 tokio::select! 以同时监听两个通道，关键帧走高优先级通道
  - SubTask 3.3: 前端 ExhibitionRemoteClient.js 区分关键帧/增量帧消息类型

- [ ] Task 4: 副本 Bug 修复借鉴审查（fix-screen-blackout, fix-input-dispatch, fix-input-matching）
  - SubTask 4.1: 阅读副本 fix-screen-blackout spec，检查主项目是否存在屏幕黑屏问题
  - SubTask 4.2: 阅读副本 fix-input-dispatch/matching spec，检查主项目输入处理是否有同类问题
  - SubTask 4.3: 如发现问题，在主项目中修复

- [ ] Task 5: server-go 添加简单 token 认证
  - SubTask 5.1: 添加 token 生成/验证中间件
  - SubTask 5.2: 实现 login API 端点
  - SubTask 5.3: 前端 App.tsx 添加登录页面组件

- [ ] Task 6: 基于 WebSocket perMessageDeflate 压缩（复本 reduce-latency P1 借鉴）
  - SubTask 6.1: 在 server-go 启用 gorilla/websocket 的压缩支持
  - SubTask 6.2: 在 tauri 侧配合启用

# Task Dependencies
- [Task 1] 独立，可并行执行
- [Task 2] 独立，可并行执行
- [Task 3] 需要 Task 6 配合（非阻塞）
- [Task 4] 独立，文档审查任务
- [Task 5] 独立，server-go 修改
- [Task 6] 独立，可并行执行
