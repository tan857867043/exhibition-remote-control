# Remote Control Widget — 集成接入文档

## 目录

1. [架构概览](#1-架构概览)
2. [快速集成](#2-快速集成)
3. [API 参考](#3-api-参考)
4. [WebSocket 实时画面](#4-websocket-实时画面)
5. [组件化方案](#5-组件化方案)
6. [Zustand Store 集成](#6-zustand-store-集成)
7. [编辑器组件注册](#7-编辑器组件注册)
8. [通信协议参考](#8-通信协议参考)

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────┐
│                 你的项目 (React 18 + Vite)          │
│                                                   │
│  ┌──────────────────┐    ┌──────────────────┐     │
│  │  设备列表页        │    │  远程控制组件      │     │
│  │  Zustand Store    │    │  RemoteControl    │     │
│  │  → 设备管理       │    │  → 实时画面       │     │
│  │  → 缩略图         │    │  → 鼠标/键盘      │     │
│  └────────┬─────────┘    └────────┬─────────┘     │
│           │                      │                │
│           ▼                      ▼                │
│    ┌──────────────────────────────────┐           │
│    │        HTTP REST API             │           │
│    │   +  WebSocket (实时画面流)       │           │
│    └────────────────┬─────────────────┘           │
└─────────────────────┼─────────────────────────────┘
                      │
                      ▼
           ┌──────────────────┐
           │   Hub (中转服务)  │  :38921
           │   Go 服务器       │
           └────────┬─────────┘
                    │
                    ▼
           ┌──────────────────┐
           │   Agent (被控端)  │
           │   Rust Windows   │
           └──────────────────┘
```

### 集成只有两个步骤

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1 | 复制 `ExhibitionRemoteClient.js` 到项目 | `src/lib/` |
| 2 | 安装依赖 `xxhashjs` | `npm install xxhashjs` |

---

## 2. 快速集成

### 2.1 复制核心文件

将 [ExhibitionRemoteClient.js](file:///e:/PY/exhibition-remote-control/src/lib/ExhibitionRemoteClient.js) 复制到你的项目：

```bash
cp exhibition-remote-control/src/lib/ExhibitionRemoteClient.js your-project/src/lib/
```

该文件是**纯浏览器端实现**，依赖清单：
- `WebSocket`（浏览器原生）
- `OffscreenCanvas` / `Canvas`（浏览器原生）
- `ImageBitmap`（浏览器原生）
- `xxhashjs`（npm 包）

### 2.2 安装依赖

```bash
npm install xxhashjs
```

### 2.3 最简单的画面接入（5 行代码）

```tsx
import { useEffect, useRef } from 'react';
import ExhibitionRemoteClient from './lib/ExhibitionRemoteClient';

export default function ScreenView({ hubUrl, deviceId }: { hubUrl: string; deviceId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const client = new ExhibitionRemoteClient(canvasRef.current, hubUrl, deviceId);
    return () => client.destroy();
  }, [hubUrl, deviceId]);

  return <canvas ref={canvasRef} className="w-full h-full" style={{ background: '#000' }} />;
}
```

---

## 3. API 参考

### 3.1 ExhibitionRemoteClient 完整 API

```typescript
interface StatsCallback {
  (stats: {
    type: 'frame' | 'freeze' | 'keyboard';
    byteLength?: number;
    frameType?: number;
    captured?: boolean;
  }): void;
}

class ExhibitionRemoteClient {
  constructor(
    canvas: HTMLCanvasElement,
    serverUrl: string,         // Hub 地址，如 "http://localhost:38921"
    deviceId: string,          // 目标设备 ID
    statsCallback?: StatsCallback  // 状态回调（可选）
  );

  // === 连接管理 ===
  destroy(): void;                              // 断开连接、清理资源

  // === 鼠标控制 ===
  sendMouseMove(x: number, y: number): void;    // 鼠标移动到 (x, y)
  sendMouseDown(btn: number): void;             // 按下鼠标按钮 (0=左, 1=右, 2=中)
  sendMouseUp(btn: number): void;               // 释放鼠标按钮
  sendScroll(deltaX: number, deltaY: number): void;  // 滚轮滚动

  // === 键盘控制 ===
  sendKeyDown(vk: number): void;                // 按下虚拟键码
  sendKeyUp(vk: number): void;                  // 释放虚拟键码
  captureKeyboard(): void;                      // 捕获键盘输入（监听 canvas 键盘事件）

  // === 画质控制 ===
  setQuality(value: number): void;              // 0-100, 默认 50
  // quality 值建议: 30 = 流畅, 50 = 均衡, 75 = 高清

  // === 统计数据 ===
  getReceivedFrameCount(): number;              // 读取累计接收帧数
  getRenderedFrameCount(): number;              // 读取累计渲染帧数
  resetFrameCounters(): void;                   // 重置帧计数器

  // === 文件传输（高级） ===
  sendFile(file: File, targetDir: string, options: {
    overwrite?: 'skip' | 'overwrite' | 'rename';
  }, onProgress?: (pct: number, speed: number, status: string) => void): Promise<void>;
  setFileManagerCallback(cb: (msg: any) => void): void;
}
```

### 3.2 Hub REST API

所有 API 地址以 Hub 地址为前缀，如 `http://localhost:38921`。

#### 设备列表

```typescript
// 获取已知设备列表（已添加的在线+离线设备）
GET /api/v1/devices
→ Response: Device[]

// 获取发现的新设备（已注册但未添加的）
GET /api/v1/devices/discovered
→ Response: Device[]

interface Device {
  id: string;        // 设备唯一 ID, 如 "8b5479e2"
  name: string;      // 设备名称（可自定义）
  os: string;        // "Windows 10 (19045)"
  ip: string;        // "192.168.1.100"
  cpu: string;       // CPU 信息
  ram: string;       // "16GB"
  mac: string;       // MAC 地址
  online: boolean;   // 在线状态
  order: number;     // 排序位置
  tags: string[];    // 用户标签
  added: boolean;    // 是否已添加到已知列表
}
```

#### 设备缩略图

```typescript
// 获取设备最新画面缩略图（JPEG）
GET /api/v1/devices/thumbnail?device_id={id}
→ Response: image/jpeg (二进制)
→ 404: 设备尚无帧数据
```

#### 设备管理

```typescript
// 添加设备到已知列表
POST /api/v1/devices/add
Body: { device_id: string }
→ { status: "ok" } | 400 | 409

// 从已知列表移除
POST /api/v1/devices/remove
Body: { device_id: string }
→ { status: "ok" } | 400 | 404

// 重命名设备
POST /api/v1/devices/rename
Body: { device_id: string, name: string }
→ { status: "ok" } | 400 | 404

// 更新排序
POST /api/v1/devices/reorder
Body: { order: string[] }  // 按顺序排列的设备 ID 数组
→ { status: "ok" }

// 更新标签
POST /api/v1/devices/tags
Body: { device_id: string, tags: string[] }
→ { status: "ok" } | 400 | 404
```

#### Agent 下载

```typescript
// 下载 Agent 可执行文件
GET /agents
→ Response: application/octet-stream (exhibition-agent.exe)
```

---

## 4. WebSocket 实时画面

### 4.1 连接地址

```
ws://{hubHost}/api/v1/stream?device_id={deviceId}
```

`ExhibitionRemoteClient` 已封装此连接过程，无需手动处理。

### 4.2 状态回调详解

`statsCallback` 接受的参数类型：

| type | 触发时机 | 附带字段 |
|------|---------|---------|
| `frame` | 收到并渲染视频帧 | `byteLength`, `frameType` |
| `freeze` | 画面冻结检测触发 | 无 |
| `keyboard` | 键盘捕获状态变化 | `captured: boolean` |

### 4.3 消息类型（发送给 Hub）

通过 WebSocket 发送的消息：

**控制指令**（TextMessage, JSON）：
```json
// 鼠标移动
{"action":"mouse_move","x":100,"y":200}

// 鼠标按下/释放
{"action":"mouse_down","button":0}
{"action":"mouse_up","button":0}

// 按键
{"action":"key_down","vk":0x41}
{"action":"key_up","vk":0x41}

// 滚轮
{"action":"scroll","delta_x":0,"delta_y":120}

// 画质调整
{"action":"set_quality","value":50}
```

**文件传输指令**（TextMessage, JSON）：
```json
// 上传文件开始
{"action":"upload_start","name":"file.txt","size":1024,"dir":"C:\\Users"}

// 创建目录
{"action":"create_dir","path":"C:\\Users\\new_folder"}

// 下载文件
{"action":"download","path":"C:\\Users\\file.txt"}
```

### 4.4 控制指令发送（不使用 ExhibitionRemoteClient 时）

如果不使用 `ExhibitionRemoteClient`，需要自行建立 WebSocket 并通过上述 JSON 指令控制设备：

```typescript
// 自行建立连接示例
const ws = new WebSocket(`ws://localhost:38921/api/v1/stream?device_id=8b5479e2`);
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  // 发送鼠标移动
  ws.send(JSON.stringify({ action: "mouse_move", x: 500, y: 300 }));
  // 发送左键点击
  ws.send(JSON.stringify({ action: "mouse_down", button: 0 }));
  ws.send(JSON.stringify({ action: "mouse_up", button: 0 }));
};

ws.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    // 收到视频帧数据，需要解析 14 字节帧头
    const buf = new Uint8Array(e.data);
    // Byte 0: frameType (0x02=全帧, 0x03=脏区域)
    // Bytes 1-2: x (16-bit big-endian)
    // Bytes 3-4: y
    // Bytes 5-6: width
    // Bytes 7-8: height
    // Bytes 9-12: jpegLen (32-bit big-endian)
    // Byte 13: cursorType
    // Bytes 14+: JPEG 数据
  }
};
```

---

## 5. 组件化方案

### 5.1 标准组件（推荐）

完整实现见 [App.tsx](file:///e:/PY/exhibition-remote-control/src/App.tsx)，核心骨架如下：

```tsx
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import ExhibitionRemoteClient from '../lib/ExhibitionRemoteClient';

export interface RemoteControlHandle {
  connect: (deviceId: string) => void;
  disconnect: () => void;
  captureKeyboard: () => void;
}

export interface RemoteControlProps {
  hubUrl: string;
  deviceId?: string;        // 可选：指定设备 ID 自动连接
  autoConnect?: boolean;    // 挂载时自动连接
  width?: number | string;
  height?: number | string;
  showToolbar?: boolean;
  showStatusBar?: boolean;
  quality?: 'smooth' | 'balanced' | 'hd';
  onStatusChange?: (status: string) => void;
  onFpsUpdate?: (fps: number) => void;
  className?: string;
}

const RemoteControl = forwardRef<RemoteControlHandle, RemoteControlProps>(
  ({ hubUrl, deviceId, autoConnect = false, width = '100%', height = 400,
     showToolbar = true, showStatusBar = true, quality = 'balanced',
     onStatusChange, onFpsUpdate, className = '' }, ref) => {

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const clientRef = useRef<ExhibitionRemoteClient | null>(null);
    const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'frozen'>('disconnected');
    const [fps, setFps] = useState(0);
    const [keyboardCaptured, setKeyboardCaptured] = useState(false);

    useImperativeHandle(ref, () => ({
      connect: (id: string) => connectDevice(id),
      disconnect: () => disconnectDevice(),
      captureKeyboard: () => clientRef.current?.captureKeyboard(),
    }));

    const connectDevice = (id: string) => {
      if (!canvasRef.current || !id) return;
      if (clientRef.current) clientRef.current.destroy();
      setStatus('connecting');
      clientRef.current = new ExhibitionRemoteClient(
        canvasRef.current, hubUrl, id, (stats) => {
          if (stats.type === 'frame') {
            setStatus('connected');
            onStatusChange?.('connected');
          } else if (stats.type === 'freeze') {
            setStatus('frozen');
            onStatusChange?.('frozen');
          } else if (stats.type === 'keyboard') {
            setKeyboardCaptured(stats.captured);
          }
        }
      );
    };

    const disconnectDevice = () => {
      clientRef.current?.destroy();
      clientRef.current = null;
      setStatus('disconnected');
      setKeyboardCaptured(false);
    };

    useEffect(() => {
      if (autoConnect && deviceId) connectDevice(deviceId);
      return () => disconnectDevice();
    }, [hubUrl, deviceId, autoConnect]);

    useEffect(() => {
      if (status !== 'connected') return;
      const timer = setInterval(() => {
        if (clientRef.current) {
          setFps(clientRef.current.getReceivedFrameCount());
          clientRef.current.resetFrameCounters();
        }
      }, 1000);
      return () => clearInterval(timer);
    }, [status]);

    return (
      <div className={`relative bg-black rounded overflow-hidden ${className}`}
           style={{ width, height }}>
        {/* Canvas */}
        <canvas ref={canvasRef} className="w-full h-full"
                style={{ objectFit: 'contain' }} />

        {/* Toolbar */}
        {showToolbar && status === 'connected' && (
          <div className="absolute top-0 left-0 right-0 h-10 bg-black/60 backdrop-blur z-10 flex items-center px-3">
            <span className="text-[11px] text-emerald-400 font-mono">{fps} FPS</span>
          </div>
        )}

        {/* Keyboard capture overlay */}
        {!keyboardCaptured && status === 'connected' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 cursor-pointer"
               onClick={() => clientRef.current?.captureKeyboard()}>
            <div className="bg-white/10 backdrop-blur px-6 py-3 rounded-lg border border-white/20 text-white text-sm">
              点击激活键盘控制
            </div>
          </div>
        )}

        {/* Status overlays */}
        {status === 'disconnected' && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">未连接</div>
        )}
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">连接中...</div>
        )}
        {status === 'frozen' && (
          <div className="absolute inset-0 flex items-center justify-center text-amber-400 text-sm bg-black/50">画面冻结</div>
        )}

        {/* Status bar */}
        {showStatusBar && (
          <div className="absolute bottom-0 left-0 right-0 h-7 bg-black/50 backdrop-blur z-10 flex items-center px-3">
            <span className={`w-2 h-2 rounded-full mr-2 ${
              status === 'connected' ? 'bg-emerald-400' :
              status === 'frozen' ? 'bg-amber-400' : 'bg-slate-600'
            }`} />
            <span className="text-[11px] text-slate-400 font-mono">
              {status === 'connected' ? `${fps} FPS` : status}
            </span>
          </div>
        )}
      </div>
    );
  }
);

export default RemoteControl;
```

### 5.2 使用方式

```tsx
// 基本使用
<RemoteControl hubUrl="http://localhost:38921" deviceId="8b5479e2" />

// 带 ref 控制
const ref = useRef<RemoteControlHandle>(null);

<RemoteControl ref={ref} hubUrl="..." width={800} height={500} />

// 工具栏全开
<RemoteControl hubUrl="..."
  deviceId="8b5479e2"
  quality="hd"
  showToolbar={true}
  showStatusBar={true}
  onStatusChange={(s) => console.log('status:', s)}
  onFpsUpdate={(f) => console.log('fps:', f)}
/>
```

### 5.3 Props 完整清单

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hubUrl` | `string` | 必填 | Hub 服务地址 |
| `deviceId` | `string` | - | 设备 ID，未提供时不连接 |
| `autoConnect` | `boolean` | `false` | 挂载时自动连接 |
| `width` | `number\|string` | `'100%'` | 组件宽度 |
| `height` | `number\|string` | `400` | 组件高度 |
| `showToolbar` | `boolean` | `true` | 显示顶部工具栏 |
| `showStatusBar` | `boolean` | `true` | 显示底部状态栏 |
| `quality` | `'smooth'\|'balanced'\|'hd'` | `'balanced'` | 画质模式 |
| `onStatusChange` | `(s: string) => void` | - | 连接状态变化回调 |
| `onFpsUpdate` | `(f: number) => void` | - | FPS 更新回调 |
| `className` | `string` | `''` | 自定义 CSS 类 |

### 5.4 Ref 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `connect` | `(deviceId: string) => void` | 连接指定设备 |
| `disconnect` | `() => void` | 断开当前连接 |
| `captureKeyboard` | `() => void` | 激活键盘捕获 |

---

## 6. Zustand Store 集成

### 6.1 设备管理 Store

```tsx
// stores/device-store.ts
import { create } from 'zustand';

interface Device {
  id: string; name: string; os: string; ip: string;
  cpu: string; ram: string; mac: string;
  online: boolean; order: number; tags: string[];
}

interface DeviceStore {
  // State
  hubUrl: string;
  devices: Device[];
  discoveredDevices: Device[];
  loading: boolean;

  // Actions
  setHubUrl: (url: string) => void;
  fetchDevices: () => Promise<void>;
  fetchDiscovered: () => Promise<void>;
  addDevice: (id: string) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
  renameDevice: (id: string, name: string) => Promise<void>;
  reorderDevices: (order: string[]) => Promise<void>;
  updateTags: (id: string, tags: string[]) => Promise<void>;
}

export const useDeviceStore = create<DeviceStore>((set, get) => ({
  hubUrl: 'http://localhost:38921',
  devices: [],
  discoveredDevices: [],
  loading: false,

  setHubUrl: (hubUrl) => set({ hubUrl }),

  fetchDevices: async () => {
    set({ loading: true });
    try {
      const res = await fetch(`${get().hubUrl}/api/v1/devices`);
      set({ devices: await res.json() });
    } finally {
      set({ loading: false });
    }
  },

  fetchDiscovered: async () => {
    try {
      const res = await fetch(`${get().hubUrl}/api/v1/devices/discovered`);
      set({ discoveredDevices: await res.json() });
    } catch (e) {
      console.error(e);
    }
  },

  addDevice: async (id) => {
    await fetch(`${get().hubUrl}/api/v1/devices/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: id }),
    });
    get().fetchDevices();
    get().fetchDiscovered();
  },

  removeDevice: async (id) => {
    await fetch(`${get().hubUrl}/api/v1/devices/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: id }),
    });
    get().fetchDevices();
  },

  renameDevice: async (id, name) => {
    await fetch(`${get().hubUrl}/api/v1/devices/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: id, name }),
    });
    get().fetchDevices();
  },

  reorderDevices: async (order) => {
    await fetch(`${get().hubUrl}/api/v1/devices/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    get().fetchDevices();
  },

  updateTags: async (id, tags) => {
    await fetch(`${get().hubUrl}/api/v1/devices/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: id, tags }),
    });
    get().fetchDevices();
  },
}));
```

### 6.2 远程控制 Store

```tsx
// stores/remote-store.ts
import { create } from 'zustand';
import ExhibitionRemoteClient from '../lib/ExhibitionRemoteClient';

interface RemoteStore {
  client: ExhibitionRemoteClient | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'frozen';
  fps: number;

  connect: (canvas: HTMLCanvasElement, hubUrl: string, deviceId: string) => void;
  disconnect: () => void;
  sendMouseMove: (x: number, y: number) => void;
  sendMouseDown: (btn: number) => void;
  sendMouseUp: (btn: number) => void;
  sendScroll: (dx: number, dy: number) => void;
  sendKeyDown: (vk: number) => void;
  sendKeyUp: (vk: number) => void;
  captureKeyboard: () => void;
  setQuality: (v: number) => void;
}

export const useRemoteStore = create<RemoteStore>((set, get) => ({
  client: null,
  status: 'disconnected',
  fps: 0,

  connect: (canvas, hubUrl, deviceId) => {
    if (get().client) get().client.destroy();
    set({ status: 'connecting' });

    const client = new ExhibitionRemoteClient(canvas, hubUrl, deviceId, (stats) => {
      if (stats.type === 'frame') set({ status: 'connected' });
      else if (stats.type === 'freeze') set({ status: 'frozen' });
    });

    set({ client });

    const timer = setInterval(() => {
      const c = get().client;
      if (c) {
        set({ fps: c.getReceivedFrameCount() });
        c.resetFrameCounters();
      } else {
        clearInterval(timer);
      }
    }, 1000);
  },

  disconnect: () => {
    get().client?.destroy();
    set({ client: null, status: 'disconnected', fps: 0 });
  },

  sendMouseMove: (x, y) => get().client?.sendMouseMove(x, y),
  sendMouseDown: (btn) => get().client?.sendMouseDown(btn),
  sendMouseUp: (btn) => get().client?.sendMouseUp(btn),
  sendScroll: (dx, dy) => get().client?.sendScroll(dx, dy),
  sendKeyDown: (vk) => get().client?.sendKeyDown(vk),
  sendKeyUp: (vk) => get().client?.sendKeyUp(vk),
  captureKeyboard: () => get().client?.captureKeyboard(),
  setQuality: (v) => get().client?.setQuality(v),
}));
```

---

## 7. 编辑器组件注册

### 7.1 组件注册配置

```tsx
// editor/component-registry.ts
import RemoteControlWidget from './components/RemoteControlWidget';
import { Settings, Monitor } from 'lucide-react';

export const componentRegistry = {
  'remote-control': {
    name: '远程画面控制',
    icon: Monitor,
    component: RemoteControlWidget,
    defaultProps: {
      hubUrl: 'http://localhost:38921',
      width: 640,
      height: 400,
      showToolbar: true,
      showStatusBar: true,
      quality: 'balanced',
    },
    // 属性面板配置
    propsPanel: [
      { key: 'hubUrl', label: 'Hub 地址', type: 'text' },
      { key: 'deviceId', label: '设备 ID', type: 'text' },
      {
        key: 'quality', label: '画质', type: 'select',
        options: [
          { value: 'smooth', label: '流畅 (30)' },
          { value: 'balanced', label: '均衡 (50)' },
          { value: 'hd', label: '高清 (75)' },
        ],
      },
      { key: 'showToolbar', label: '显示工具栏', type: 'boolean' },
      { key: 'showStatusBar', label: '显示状态栏', type: 'boolean' },
      { key: 'width', label: '宽度', type: 'number' },
      { key: 'height', label: '高度', type: 'number' },
    ],
    // 编辑器模式渲染（预览占位）
    editorRender: () => (
      <div className="w-full h-full bg-slate-900 flex items-center justify-center text-slate-500">
        <div className="flex flex-col items-center gap-2">
          <Monitor className="w-8 h-8" />
          <span className="text-xs">远程画面控制</span>
          <span className="text-[10px] text-slate-600">双击配置设备</span>
        </div>
      </div>
    ),
  },
};
```

### 7.2 编辑器模式与运行时模式

```tsx
// 编辑器组件
function RemoteControlEditorWrapper(props) {
  const { editorMode, ...rest } = props;

  if (editorMode) {
    // 编辑模式：显示占位，不发起 WebSocket 连接
    return <Placeholder width={rest.width} height={rest.height} />;
  }

  // 运行时模式：自动连接并显示实时画面
  return <RemoteControl {...rest} autoConnect />;
}
```

### 7.3 属性面板示例（基于 Lucide-react）

```tsx
function RemoteControlPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4 p-4">
      <div>
        <label className="text-xs text-slate-400 block mb-1">Hub 地址</label>
        <input type="text" value={props.hubUrl}
          onChange={e => onChange({ ...props, hubUrl: e.target.value })}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">设备 ID</label>
        <input type="text" value={props.deviceId}
          onChange={e => onChange({ ...props, deviceId: e.target.value })}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">画质</label>
        <div className="flex gap-1">
          {['smooth', 'balanced', 'hd'].map(q => (
            <button key={q}
              onClick={() => onChange({ ...props, quality: q })}
              className={`px-3 py-1.5 rounded text-xs font-bold transition-colors ${
                props.quality === q
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}>
              {q === 'smooth' ? '流畅' : q === 'balanced' ? '均衡' : '高清'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## 8. 通信协议参考

### 8.1 视频帧二进制格式

```
Byte 0:      frameType (0x02=全帧I帧, 0x03=脏区域P帧, 0x04=关键帧)
Bytes 1-2:   x 坐标 (16-bit big-endian)
Bytes 3-4:   y 坐标 (16-bit big-endian)
Bytes 5-6:   宽度 (16-bit big-endian)
Bytes 7-8:   高度 (16-bit big-endian)
Bytes 9-12:  JPEG 数据长度 (32-bit big-endian)
Byte 13:     鼠标光标类型 (0=default, 1=text, 2=pointer, 3=ns-resize, ...)
Bytes 14+:   JPEG 编码的图像数据
```

### 8.2 光标类型映射

| 类型 ID | CSS Cursor | Windows 图标 | 说明 |
|---------|-----------|-------------|------|
| 0 | `default` | IDC_ARROW | 默认箭头 |
| 1 | `text` | IDC_IBEAM | 文本输入 |
| 2 | `pointer` | IDC_HAND | 链接手型 |
| 3 | `ns-resize` | IDC_SIZENS | 上下调整 |
| 4 | `ew-resize` | IDC_SIZEWE | 左右调整 |
| 5 | `wait` | IDC_WAIT | 忙碌 |
| 6 | `crosshair` | IDC_CROSS | 十字准星 |
| 7 | `move` | IDC_SIZEALL | 四向移动 |

### 8.3 独立光标消息

```
[0x0A, cursor_type]   (2 bytes, 独立于视频帧)
```

光标变化时立即发送，不等待视频帧。前端收到后即时更新 CSS cursor。

### 8.4 鼠标按钮值

| 值 | 按钮 |
|----|------|
| 0 | 左键 |
| 1 | 右键 |
| 2 | 中键 |
| 3 | 侧键1 |
| 4 | 侧键2 |

---

## 快速清单

```bash
# 1. 复制核心文件
cp <源项目>/src/lib/ExhibitionRemoteClient.js ./src/lib/

# 2. 安装依赖
npm install xxhashjs

# 3. 测试连通性
curl http://localhost:38921/api/v1/devices

# 4. 集成组件
# 参考第 5 节创建 RemoteControl 组件
```
