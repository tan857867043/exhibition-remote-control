# Exhibition Remote Control

展厅远程控制系统 — Go 后端 + Rust 被控端 + React 前端

## 架构

```
浏览器 (React) ──WebSocket──▶ Go Hub (:38921) ◀──WebSocket── Rust Agent
                 控制指令                           屏幕画面
```

## 快速启动

### 1. Go 后端

```bash
cd server-go
go run main.go
# 启动在 :38921
```

### 2. Rust 被控端

```bash
cd agent-rust
cargo build --release
.\target\release\exhibition-agent.exe
# 默认连接 ws://127.0.0.1:38921
```

### 3. 前端

```bash
npm install
npx vite --host 0.0.0.0 --port 3001
# 打开 http://localhost:3001
```

## 部署到其他机器

### 分发 Agent

1. 浏览器打开 `http://<服务器IP>:3001`
2. 点击 **下载 Agent** 按钮
3. 在目标机器解压运行 exe（已自动注入服务器地址）

Agent 服务器地址通过 PE 尾部追加方式注入，exe 为单文件，无需配置文件。

### 防火墙

服务器需开放 **38921** (Go Hub) 和 **3001** (前端) 端口：

```powershell
# Windows
New-NetFirewallRule -DisplayName "Exhibition 38921" -Direction Inbound -Protocol TCP -LocalPort 38921 -Action Allow
New-NetFirewallRule -DisplayName "Exhibition 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow
```

### Agent 手动配置

如果不用下载端点，可手动在 exe 尾部追加配置：

```
---EXHIBITION_CONF---
server=ws://192.168.1.100:38921
```

## 项目结构

```
├── agent-rust/          # Rust 被控端（屏幕捕获、JPEG 编码）
├── server-go/           # Go 中转中心（WebSocket 路由、API）
├── src/                 # React 前端
│   └── lib/ExhibitionRemoteClient.js  # 远程控制客户端
└── frontend-client/     # 独立前端页面
```

## 技术要点

- **自适应画质引擎**: 根据画面变化率和 CPU 负载动态调整 JPEG 质量和帧率
- **脏矩形检测**: 网格哈希 + 连通分量包围盒合并，仅传输变化区域
- **MPSC 异步发送**: 捕获/编码与网络 I/O 解耦
- **光标同步**: 通过 Windows API 捕获被控端光标类型，前端动态切换 CSS cursor
