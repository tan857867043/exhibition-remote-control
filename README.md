# Exhibition Remote Control

一个基于 Web 的展厅远程控制系统，支持实时屏幕画面传输、键盘鼠标远程控制、多设备管理。

## 架构

```
┌─────────────────────────────────────────────────────┐
│                  Frontend (React + Vite)             │
│  http://localhost:3001                               │
│  设备列表 / 远程控制界面 / 实时画面流                │
└────────────────────────┬────────────────────────────┘
                         │ WebSocket (画面数据)
                         │ HTTP REST (控制指令)
                         ▼
┌─────────────────────────────────────────────────────┐
│               Server (Go + gorilla/websocket)        │
│  :38921                                              │
│  设备注册 / 画面中转 / 控制指令透传                  │
└────────────────────────┬────────────────────────────┘
                         │ WebSocket (画面数据)
                         ▼
┌─────────────────────────────────────────────────────┐
│          Agent (Rust + scrap + turbojpeg)            │
│  屏幕捕获 / JPEG编码 / 脏矩形检测 / 远程控制接收     │
└─────────────────────────────────────────────────────┘
```

### 组件

| 组件 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| **server-go** | Go + gorilla/websocket | 38921 | 数据中转中心，设备注册/画面广播/控制透传 |
| **agent-rust** | Rust + scrap + turbojpeg + enigo | — | 被控端 Agent，屏幕捕获编码、接收控制指令 |
| **frontend** | React + Vite + Tailwind | 3001 | Web 控制台，设备列表/远程桌面/实时统计 |

## 快速开始

### 环境要求

- Go 1.21+
- Rust (stable) — 需要 MSVC 工具链 (Windows)
- Node.js 18+
- CMake 3.0+ (编译 turbojpeg 依赖)

### 1. 启动中转服务器

```bash
cd server-go
go run main.go
# 输出: 展厅远程控制数据中转中心已在 :38921 端口启动...
```

### 2. 编译并启动 Agent（被控端）

```bash
cd agent-rust
cargo build --release
.\target\release\exhibition-agent.exe
# 输出: Connecting to hub at ws://127.0.0.1:38921/agent/register?...
```

Agent 启动后会自动连接到中转服务器并注册设备信息（主机名、OS、CPU、内存、MAC 地址）。

### 3. 启动前端控制台

```bash
npm install
npm run dev
# 访问 http://localhost:3001
```

### Agent 注入服务器地址

Agent 默认连接 `127.0.0.1:38921`。如需连接到远程服务器，可通过 EXE 尾部注入配置：

```
[exe 原始数据][JSON 字符串:{"server":"ws://192.168.1.100:38921"}][4字节 BE 长度][16字节 Marker "EXHIBITIONCONFIG"]
```

## 性能特性

- **自适应画质引擎**：根据画面变化率和 CPU 负载动态调整 JPEG 质量 (Q=30-95) 和帧率 (5-30 FPS)
- **脏矩形检测**：64x64 网格 + SIMD (AVX2/SSE2) 加速差异检测 + BFS 连通分量合并
- **增量块 BGRA 直传**：小块 (<128x128) 用 raw BGRA + `putImageData` 直渲，免去 JPEG 编解码
- **Cursor Pseudo-Encoding**：光标独立叠加层，移动时不触发画面重传
- **MPSC 通道解耦**：网络发送与画面捕获分离，非阻塞 `try_send`
- **GPU 友好渲染**：离屏 Canvas + `requestAnimationFrame` 渲染队列 + 帧淘汰
- **每个订阅者独立缓冲通道**：带 16 帧缓冲，满则丢帧，慢订阅者不阻塞其他客户端
- **视频模式降采样**：高变化场景自动降采样 1/2 分辨率并启用 4:2:0 色度子采样

## API 接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/agent/register` | WebSocket | Agent 注册与画面数据上报 |
| `/api/v1/devices` | GET | 获取在线设备列表 |
| `/api/v1/devices/thumbnail?device_id=X` | GET | 获取设备最新画面缩略图 (JPEG) |
| `/api/v1/stream?device_id=X` | WebSocket | 订阅设备画面流与控制 |
| `/api/v1/control` | POST | 外部控制指令 API |

### 控制指令格式

```json
{
  "device_id": "f879bf73",
  "action": "mouse_move",
  "x": 100,
  "y": 200
}
```

支持的动作：`mouse_move`、`mouse_down`、`mouse_up`、`mouse_click`、`mouse_wheel`、`key_press`、`key_release`

## 画面消息格式

| 类型 | 值 | 格式 |
|------|-----|------|
| 全帧 | 0x02/0x03 | `[type:1][x:2][y:2][w:2][h:2][jpeg_data]` |
| 批量增量块 | 0x01 | `[0x01][count:2][block...]` 每块: `[x:2][y:2][w:2][h:2][enc:1][len:2][data]` |
| 光标位置 | 0x07 | `[0x07][cursor_x:2][cursor_y:2]` |
| 光标形状 | 0x08 | `[0x08][cursor_type:1]` |

- encoding: 0=JPEG, 1=BGRA raw

## 开发

```bash
# 前端热更新
npm run dev

# Agent release 编译
cd agent-rust && cargo build --release

# Go 后端热更新
cd server-go && go run main.go
```
