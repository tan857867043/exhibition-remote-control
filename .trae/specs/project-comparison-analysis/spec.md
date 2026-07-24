# 项目对比分析 Spec

## Why

用户提供了另一个版本的 `exhibition-remote-control`（D盘副本），需要系统性地对比两个项目的差异，找出各自的优缺点和可借鉴的技术方案，以指导后续开发方向。

## 两个项目概述

### 主项目（E盘，当前工作区）

```
e:\PY\exhibition-remote-control/
├── agent-rust/           # Rust Agent（模块化，5源文件）
│   ├── src/main.rs       # 主逻辑入口（515行）
│   ├── src/dirty_rect.rs # 脏矩形检测（GridManager）
│   ├── src/capture.rs    # 屏幕捕获（scrap）
│   ├── src/encoder.rs    # 编码与二进制包构建
│   └── src/bin.rs        # 监控/信息采集工具
├── server-go/            # Go 1.21 数据中转中心 :38921
│   ├── main.go           # 入口（端口38921）
│   ├── hub/device.go     # DeviceHub 数据结构 + 全局实例
│   └── hub/router.go     # 路由 & WebSocket 处理
├── src/                  # React + Vite 前端
│   ├── App.tsx            # 主应用组件（React 19 + Tailwind 4）
│   ├── main.tsx           # 入口
│   ├── index.css          # Tailwind 样式
│   └── lib/ExhibitionRemoteClient.js  # WebSocket 流客户端（380行）
├── index.html             # Vite 入口 HTML
├── package.json           # React 19 + Vite + Tailwind 4
├── tsconfig.json          # TypeScript 配置
├── metadata.json          # AI Studio 元数据
├── .env.example           # 环境变量（GEMINI_API_KEY）
├── .gitignore
├── Cargo.toml             # Rust 项目配置
├── README.md              # 完整项目文档
├── test.rs / test2.rs / test3.rs  # 小测试文件（turbojpeg/sysinfo）
└── Test001/               # 旧版备份（旧 agent-rust + server + server-node）
```

**组件关系**（摘自 README）：
```
Frontend (React + Vite)  :3001
        ↓ WebSocket (画面数据) / HTTP REST (控制指令)
Server (Go + gorilla/websocket)  :38921
        ↓ WebSocket
Agent (Rust + scrap + turbojpeg)
```

### 副本项目（D盘，微信收到的版本）

```
exhibition-remote-control - 副本/
├── agent-rust/           # Rust Agent（单体，1源文件1665行）
│   └── src/main.rs       # 全部代码
├── server/               # Express.js 服务 :8443
│   ├── index.js          # 认证 + Agent下载 + 流中转
│   ├── config.json       # 服务器配置文件
│   ├── sessions.json     # 会话持久化
│   ├── certs/            # SSL 证书
│   └── public/           # 静态文件（index.html无）
├── server-node/          # 轻量 HTTP+WS 集线器 :8080
│   ├── main.js           # 入口
│   ├── hub/device-hub.js # DeviceHub 类
│   ├── hub/router.js     # 路由 & WebSocket
│   ├── hub/exe-config.js # Agent 编译时配置注入
│   └── public/           # 前端页面
│       ├── index.html    # 完整 SPA（474行）
│       └── test.html     # 测试页面
├── dist/                 # 预编译 Agent
│   ├── template/ExhibitionAgent.exe  # 模板
│   ├── Agent_展厅A.exe
│   ├── ExhibitionAgent.exe
│   └── ExhibitionAgent_test.exe
├── .trae/specs/          # 大量演进 Spec（15+个）
└── .gitignore
```

## 一、架构对比

| 维度 | 主项目（E盘） | 副本项目（D盘） |
|------|-------------|-------------|
| Agent | Rust，模块化5文件 | Rust，单体1665行 |
| 服务端 | **Go 1.21**（单二进制，gorilla/websocket） | Node.js **Express** + Node.js **server-node** |
| 前端 | **React 19 + Vite + Tailwind 4**（TSX） | 纯 JS 单页面（无框架） |
| 前端路由 | SPA 路由（设备列表/远程桌面） | 单页内切换 |
| 端口 | 38921（Go）+ 3001（Vite Dev） | 8443（Express）+ 8080（server-node） |
| 缩略图 | **支持**（LatestFrame 缓存 + /thumbnail API） | 无 |
| 认证 | 无 | Express 端有（cookie/session） |
| Agent下载 | 无 | Express 端有（exe 尾部注入配置） |
| 部署 | Go 单二进制 + Vite Build 静态文件 | Node.js 需 node_modules + 运行时 |

## 二、Agent 端详细对比

### 2.1 代码模块化

- **主项目优**：main.rs (515行) + dirty_rect.rs (162行) + capture.rs (30行) + encoder.rs (143行) + bin.rs (30行)
- **副本项目**：全部在 main.rs（1665行），功能丰富但维护困难

### 2.2 屏幕捕获

| 特性 | 主项目 | 副本项目 |
|------|--------|---------|
| 捕获库 | scrap（仅 DXGI） | scrap + **GDI 双路回退** |
| 分辨率支持 | 不支持自定义 | 支持 `--width` `--height` |
| 降采样 | **1/2 最近邻降采样**（视频场景） | 无 |

### 2.3 脏区域检测

| 特性 | 主项目 | 副本项目 |
|------|--------|---------|
| 算法 | GridManager + CRC32 hash + BFS 连通分量合并 + MCU 16对齐 | Tile-based 64px + BFS + MCU 16对齐 |
| SIMD 加速 | **AVX2/SSE2 脏块检测** | 无 |
| 静态帧跳过 | 无 | **xxhash64 全帧哈希跳过** |

### 2.4 编码与传输

| 特性 | 主项目 | 副本项目 |
|------|--------|---------|
| JPEG | turbojpeg | mozjpeg-rs + jpeg-encoder 双回退 |
| 小区域 | **<128x128 raw BGRA**（免JPEG） | 全 JPEG |
| 批量包 | **v2 协议**（per-block 编码类型） | v1 协议 |
| 自适应画质 | **QualityEngine**（变化率+带宽+CPU+编码耗时） | 简单阈值调整 |
| 光标处理 | **CursorShapeTracker**（0x07位置+0x08形状，独立叠加层） | 无（画面内包含光标） |
| 双通道 | 无 | keyframe/delta 分离 mpsc 通道 |

### 2.5 输入处理

| 特性 | 主项目 | 副本项目 |
|------|--------|---------|
| 鼠标 | **SendInput + SetCursorPos**（Windows API级） | enigo（跨平台有限） |
| 按键批处理 | **支持多键批量发送** | 单键发送 |
| 安全过滤 | **命令黑名单**（format/shutdown/diskpart等） | 无 |
| Ctrl+Alt+Del | **支持** | 无 |

### 2.6 遥测

| 特性 | 主项目 | 副本项目 |
|------|--------|---------|
| CPU 监控 | **独立任务 500ms 刷新，原子变量节流** | 主循环中刷新 |
| 遥测发送 | **每30秒** | 无 |
| 信息维度 | **CPU名称/使用率、RAM总量/已用、MAC、OS** | 基础名称/分辨率 |

## 三、服务端对比（Go vs Node.js）

| 特性 | 主项目 server-go | 副本 server (Express) | 副本 server-node |
|------|-----------------|---------------------|-----------------|
| 语言 | Go 1.21 | Node.js + Express | Node.js + ws |
| 依赖 | 1个（gorilla/websocket） | 4+（express/ws/cookie-parser/uuid） | 1个（ws） |
| 部署产物 | **单二进制** | node_modules + 运行时 | node_modules + 运行时 |
| 并发模型 | RWMutex + goroutine | 单线程事件循环 | 单线程事件循环 |
| 写保护 | **专用写 goroutine + 5s deadline** | 直接写 ws | 直接写 ws |
| 推送模型 | **缓冲通道**（chan []byte, cap 16, 满则丢帧） | Set 集合直接遍历 | Set 集合直接遍历 |
| LatestFrame | **支持**（存最新JPEG） | 无 | 无 |
| Thumbnail API | **支持** | 无 | 无 |
| 前端托管 | 无（需 Vite Dev 或 nginx） | 有（express.static） | 有（静态文件） |
| 认证 | 无 | cookie/session | 无 |
| Agent下载 | 无 | 有（尾部注入配置） | 有（exe-config） |

**主项目 server-go 核心优势**：
- 单二进制部署、零运行时依赖、高性能 goroutine 并发
- LatestFrame 缓存 + Thumbnail API（缩略图省去额外截图请求）
- 订阅者缓冲通道（满帧自动丢弃，慢订阅者不阻塞）
- 写超时保护

**副本项目 server 优势**：
- 认证系统（login/logout + authMiddleware）
- Agent 动态下载（exe 尾部注入配置）
- 前端页面直接托管

**注意**：副本的 Express server 端口 8443（有认证）与 server-node 端口 8080（无认证）是两套独立服务。

## 四、前端对比

| 特性 | 主项目（React + Vite） | 副本项目（纯 JS SPA） |
|------|----------------------|---------------------|
| 技术栈 | **React 19 + TSX + Tailwind 4 + lucide-react** | 原生 JS + 手写 CSS |
| 包体积 | 大（React + Tailwind） | 小（无框架） |
| 开发效率 | **高**（组件化、TypeScript、Tailwind） | 低（手写 DOM） |
| 设备列表 | **网格卡片式**，缩略图预览 | 列表式，无缩略图 |
| 远程桌面 | **全屏支持、画质切换（流畅/均衡/高清）** | 全屏支持、画质切换（3档） |
| 性能统计 | FPS / KB/s / Resolution（React setState 每2秒） | FPS / KB/s / 帧大小（每1秒） |
| 键盘映射 | **完整 VK 映射表**（两者同源，代码几乎一致） | 完整 VK 映射表 |
| 鼠标处理 | **letterbox 坐标校正 + 16ms 节流** | letterbox 坐标校正 + 16ms 节流 |
| 键盘批处理 | **2ms 批量 + 修饰键即时** | 2ms 批量 + 修饰键即时 |
| 光标叠加 | Canvas 绘制光标圆圈 | CSS cursor 样式切换 |
| 设备命名 | **自定义显示名称（localStorage 持久化）** | 无 |
| 缩略图展示 | **设备列表直接显示 LatestFrame 缩略图** | 无 |
| 端到端渲染 | 离屏 Canvas + rAF 渲染队列 + 帧淘汰 | 双缓冲 + createImageBitmap 异步渲染 |
| 增量块渲染 | **putImageData (BGRA 直传)** + JPEG 批量解码 | createImageBitmap |

**关键发现**：两个前端虽然技术栈不同（React vs 原生JS），但**底层流客户端逻辑几乎相同**。主项目的 `ExhibitionRemoteClient.js` 与副本项目的 `processBatchRegions` 函数逻辑高度一致，说明它们同源。

## 五、Spec 演进方向对比

| 方向 | 主项目 Specs | 副本项目 Specs |
|------|-------------|---------------|
| 性能 | benchmark-optimization（光标伪编码、小块 raw BGRA）、optimize-frontend-fps（rAF 队列） | reduce-latency（mpsc 双通道）、cursor-display/composite-perf（光标复合渲染）、realtime-optimization（分辨率自适应、SIMD） |
| Bug 修复 | 无 | fix-screen-blackout（黑屏）、fix-input-dispatch/ fix-input-matching（输入）、fix-latency-regressions（延迟回退）、fix-cursor-composite-perf（光标性能） |
| 服务端 | 无 | align-rustdesk-cursor（RustDesk 光标对齐） |
| Agent 部署 | 无 | server-cursor-composite/toggle-cursor-visibility/cursor-frame-sync/cursor-highfreq/adopt-comparison-3（大量光标相关优化） |

## 六、关键借鉴点

### 副本 → 主项目（D→E）：需要补充的功能

| 优先级 | 特性 | 说明 |
|--------|------|------|
| P0 | **xxhash64 静态帧跳过** | 全帧哈希快速跳过未变化画面，大幅降低 CPU 负载 |
| P1 | **scrap + GDI 双路回退** | DXGI 不可用时自动回退 GDI BitBlt |
| P1 | **自定义分辨率参数** | `--width` `--height` 命令行支持 |
| P2 | **keyframe/delta 分离通道** | mpsc 双通道减少关键帧延迟 |
| P2 | **认证系统** | server-go 添加简单 token 认证 |
| P3 | **Agent 动态下载端点** | 通过 HTTP 提供定制化的 Agent exe |
| P3 | **Bug 修复借鉴** | 副本发现并修复了多个问题（黑屏、输入匹配等），检查主项目是否存在同类问题 |

### 主项目 → 副本（E→D）：主项目已领先的功能

| 特性 | 说明 |
|------|------|
| **Go 服务端** | 单二进制、高性能、零依赖，优于 Node.js 架构 |
| **React 前端** | 组件化、TypeScript、Tailwind，开发效率更高 |
| **LatestFrame + Thumbnail** | 缩略图 API 省去额外截图，体验更好 |
| **SendInput 原生输入** | Windows API 级别，比 enigo 可靠 |
| **命令安全过滤** | 黑名单机制防止危险命令 |
| **Ctrl+Alt+Del** | 特殊组合键支持 |
| **QualityEngine** | 自适应画质（变化率+带宽+CPU+编码耗时） |
| **小块 raw BGRA** | <128x128 区域免 JPEG 编码，降低延迟 |
| **模块化代码** | 5 文件拆分，维护性更好 |
| **订阅者缓冲通道** | server-go 的 chan 缓冲 + 写 deadline |
| **自定义设备命名** | localStorage 持久化，用户体验更好 |
| **AI Studio 集成** | metadata.json + .env.example 支持云端部署 |
