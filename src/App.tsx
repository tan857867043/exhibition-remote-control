import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ExhibitionRemoteClient from "./lib/ExhibitionRemoteClient.js";
import { Monitor, WifiOff, Settings, Mouse, Cast, Lock, Terminal, Router, X, Maximize, Minimize, ChevronLeft, ChevronRight, Zap, Image as ImageIcon, Activity, Folder, FolderOpen, FolderInput, FolderX, UploadCloud, Download, Copy, Check, Search, Power, RefreshCw, ChevronUp, ChevronDown, Plus, Server, Network, Info, Layers, Table, SlidersHorizontal, CheckCircle2, XCircle, FileWarning, FileDown, File, RotateCw, Trash2, HelpCircle, LayoutGrid, List } from "lucide-react";
import { traverseFileTree } from "./lib/fileSystem";
import { FileManager, TransferTaskItem } from "./components/FileManager";
import FileTransferClient from "./lib/FileTransferClient";
import { TerminalModal } from "./components/TerminalModal";
import { SystemConfigPanel } from "./components/SystemConfigPanel";
import { RemoteDirPicker } from "./components/RemoteDirPicker";
import { Toaster, DialogHost, toast, confirmDialog, promptDialog } from "./lib/ui";

// 侧栏"未分组"虚拟分组标识（避免与真实分组名冲突）
const UNGROUPED_GROUP = "__ungrouped__";

interface DeviceInfo {
  id: string;
  name: string;
  os: string;
  ip: string;
  cpu: string;
  ram: string;
  mac: string;
  online: boolean;
  order: number;
  tags: string[];
  added: boolean;
}

type AppView = "devices" | "remote" | "device-info" | "file-transfer" | "settings";

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("ur-server-url") || "http://localhost:38921");
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // 缩略图缓存键：同一 epoch 内轮询重渲染不改变缩略图 URL，避免在线设备缩略图每 5 秒重新下载
  const [thumbEpoch, setThumbEpoch] = useState(() => Date.now());
  const [dragDeviceId, setDragDeviceId] = useState<string | null>(null);
  const [dragOverDeviceId, setDragOverDeviceId] = useState<string | null>(null);
  const [discoveredDevices, setDiscoveredDevices] = useState<DeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState<"disconnected" | "loading" | "connected" | "connecting" | "frozen" | "reconnecting">("disconnected");
  const [currentView, setCurrentView] = useState<AppView>("devices");
  const [serverReachable, setServerReachable] = useState(true);

  const [renderedFps, setRenderedFps] = useState(0);
  const [receivedFps, setReceivedFps] = useState(0);
  const [dataRate, setDataRate] = useState(0);
  const [blockCount, setBlockCount] = useState(0);
  const [resolution, setResolution] = useState("--");
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [qualityMode, setQualityMode] = useState<"smooth" | "balanced" | "hd">(() => {
    const saved = localStorage.getItem("ur-quality-mode") as "smooth" | "balanced" | "hd" | null;
    return saved || "balanced";
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("ur-theme") as "dark" | "light" | null;
    return saved || "dark";
  });
  // 设备页视图模式：cards 卡片视图 / grouped 分组视图，持久化到 localStorage
  const [deviceViewMode, setDeviceViewMode] = useState<"cards" | "grouped">(() => {
    const saved = localStorage.getItem("ur-device-view-mode");
    return saved === "grouped" ? "grouped" : "cards";
  });


  const [modalOpen, setModalOpen] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingTags, setEditingTags] = useState("");
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  const [targetDir, setTargetDir] = useState("D:\\");
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [fileManagerMinimized, setFileManagerMinimized] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [fmTransferTasks, setFmTransferTasks] = useState<TransferTaskItem[]>([]);
  const [batchSelectedDevices, setBatchSelectedDevices] = useState<Set<string>>(new Set());
  const [batchPendingFiles, setBatchPendingFiles] = useState<File[]>([]);
  const [batchGlobalTargetPath, setBatchGlobalTargetPath] = useState("D:\\");
  const [batchDevicePaths, setBatchDevicePaths] = useState<Record<string, string>>({});
  const [batchPickerDeviceId, setBatchPickerDeviceId] = useState<string | null>(null);
  const [batchTransferring, setBatchTransferring] = useState(false);
  // 批量传输覆盖策略：skip 跳过 / overwrite 覆盖 / rename 自动重命名
  const [batchOverwriteMode, setBatchOverwriteMode] = useState<"skip" | "overwrite" | "rename">("skip");
  // 批量传输任务 -> 原始 File 引用，供失败任务重试时真正重发
  const batchTaskFilesRef = useRef<Map<string, File>>(new Map());
  const [batchDeviceSearch, setBatchDeviceSearch] = useState("");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [terminalDevice, setTerminalDevice] = useState<{ id: string; name: string } | null>(null);
  const [configPanelDevice, setConfigPanelDevice] = useState<{ id: string; name: string; online: boolean } | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>(() => localStorage.getItem("ur-selected-group") || "all");
  const [customGroups, setCustomGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("ur-custom-groups") || "[]"); }
    catch { return []; }
  });
  // 侧栏分组展开状态：持久化到 localStorage，刷新后保持
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("ur-expanded-groups") || "[]"); }
    catch { return []; }
  });
  useEffect(() => {
    localStorage.setItem("ur-expanded-groups", JSON.stringify(expandedGroups));
  }, [expandedGroups]);

  const q = searchQuery.trim().toLowerCase();

  // 合并设备已有标签 + 本地创建的空分组
  const allGroups = useMemo(() => {
    const addedDevices = devices.filter(d => d.added);
    const tagCounts: Record<string, number> = {};
    addedDevices.forEach(d => {
      (d.tags || []).forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });
    customGroups.forEach(g => {
      if (!(g in tagCounts)) tagCounts[g] = 0;
    });
    return Object.entries(tagCounts).map(([name, count]) => ({ name, count }));
  }, [devices, customGroups]);

  // 分组颜色：每个分组分配一个稳定色
  const GROUP_COLORS = [
    '#60A5FA', '#34D399', '#FBBF24', '#A78BFA',
    '#F472B6', '#22D3EE', '#FB923C', '#4ADE80',
  ];
  const getGroupColor = (name: string): string => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i), hash |= 0;
    return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
  };

  // 当前选中分组（含"未分组"虚拟分组）是否包含某台设备
  const inSelectedGroup = (d: DeviceInfo) =>
    selectedGroup === "all" ? true :
    selectedGroup === UNGROUPED_GROUP ? !(d.tags || []).length :
    (d.tags || []).includes(selectedGroup);

  const onlineDevices = useMemo(() => {
    return devices
      .filter(d => d.added && d.online)
      .filter(d => inSelectedGroup(d))
      .filter(d => !q || d.name.toLowerCase().includes(q) || d.os.toLowerCase().includes(q) || d.ip.toLowerCase().includes(q))
      .sort((a, b) => a.order - b.order);
  }, [devices, q, selectedGroup]);

  const offlineDevices = useMemo(() => {
    return devices
      .filter(d => d.added && !d.online)
      .filter(d => inSelectedGroup(d))
      .filter(d => !q || d.name.toLowerCase().includes(q) || d.os.toLowerCase().includes(q) || d.ip.toLowerCase().includes(q))
      .sort((a, b) => a.order - b.order);
  }, [devices, q, selectedGroup]);

  const filteredDiscovered = useMemo(() => {
    return discoveredDevices
      .filter(d => !q || d.name.toLowerCase().includes(q) || d.os.toLowerCase().includes(q) || d.ip.toLowerCase().includes(q));
  }, [discoveredDevices, q]);

  const totalProgress = useMemo(() => {
    const totalSize = fmTransferTasks.reduce((sum, t) => sum + (t.size || 0), 0);
    if (totalSize === 0) return { percent: 0, done: 0, total: 0 };
    const doneSize = fmTransferTasks.reduce((sum, t) => {
      if (t.status === "completed") return sum + (t.size || 0);
      return sum + ((t.size || 0) * (t.progress || 0)) / 100;
    }, 0);
    const fmt = (b: number) => {
      if (b < 1024) return b + " B";
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
      return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
    };
    return {
      percent: Math.round((doneSize / totalSize) * 100),
      done: doneSize,
      total: totalSize,
      doneStr: fmt(doneSize),
      totalStr: fmt(totalSize),
    };
  }, [fmTransferTasks]);

  // ── Settings: apply theme to DOM (live) ──
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // ── Settings: persist to localStorage ──
  useEffect(() => { localStorage.setItem("ur-server-url", serverUrl); }, [serverUrl]);
  useEffect(() => { localStorage.setItem("ur-quality-mode", qualityMode); }, [qualityMode]);
  useEffect(() => { localStorage.setItem("ur-selected-group", selectedGroup); }, [selectedGroup]);
  useEffect(() => { localStorage.setItem("ur-theme", theme); }, [theme]);
  useEffect(() => { localStorage.setItem("ur-device-view-mode", deviceViewMode); }, [deviceViewMode]);
  useEffect(() => {
    try { localStorage.setItem("ur-custom-groups", JSON.stringify(customGroups)); } catch { /* noop */ }
  }, [customGroups]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<any>(null);
  // ── 自动重连状态 ──
  const userDisconnectRef = useRef(false);                 // 用户是否主动断开
  const reconnectTimerRef = useRef<number | null>(null);   // 重连定时器 id
  const reconnectAttemptRef = useRef(0);                   // 重连尝试次数（指数退避）
  const connectTimerRef = useRef<number | null>(null);     // 等待 canvas 挂载的延迟连接定时器
  const activeWsRef = useRef<WebSocket | null>(null);      // 当前活动 ws，用于过滤旧连接销毁引发的 onclose

  const handleSendFiles = async (files: FileList | File[], dir: string, overwriteMode: string, applyToAll: boolean, directories?: string[]) => {
    if (!clientRef.current) {
      toast("请先连接到远程设备", "info");
      return;
    }
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    // 上传前探测远端目标路径：不存在时提示用户确认是否自动创建
    try {
      const exists = await clientRef.current.checkDirExists(dir);
      if (!exists) {
        const shouldCreate = await confirmDialog(
          `远端路径 "${dir}" 不存在。\n是否自动创建该目录后继续上传？`
        );
        if (!shouldCreate) {
          toast("已取消上传，请修改远程保存路径后重试。", "info");
          return;
        }
        clientRef.current.createDir(dir);
      }
    } catch (err) {
      // 探测失败（如连接异常）不阻塞上传，交由 Agent 上传流程兜底创建目录
      console.warn("[FileTransfer] 目录探测失败，继续上传（Agent 兜底创建）:", err);
    }

    if (directories && directories.length > 0 && clientRef.current.ws && clientRef.current.ws.readyState === WebSocket.OPEN) {
      for (const dirPath of directories) {
        clientRef.current.ws.send(JSON.stringify({ action: "create_dir", path: `${dir}\\${dirPath}` }));
      }
    }

    const ov = overwriteMode === "skip" ? "skip" : overwriteMode === "overwrite" ? "overwrite" : "rename";

    // Show the FileManager UI right away to indicate progress
    setFileManagerOpen(true);
    setFileManagerMinimized(false);

    for (const file of fileArray) {
      const taskId = `ul_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      // 统一相对路径为反斜杠（webkitdirectory 选择返回正斜杠，会破坏 Windows 路径层级）
      const relPath = (((file as any)._relativePath || (file as any).webkitRelativePath || '') as string).replace(/[\\/]/g, "\\");
      const fileTargetDir = relPath ? `${dir}\\${relPath}` : dir;

      const newTask: TransferTaskItem = {
        id: taskId,
        direction: "upload",
        name: relPath ? `${relPath}\\${file.name}` : file.name,
        size: file.size,
        sourcePath: fileTargetDir,
        targetPath: fileTargetDir,
        progress: 0,
        status: "transferring",
        speed: 0
      };

      setFmTransferTasks((prev) => [newTask, ...prev]);

      try {
        await clientRef.current.sendFile(
          file,
          fileTargetDir,
          { overwrite: ov },
          (progress: number, speedMBs: number, status: string) => {
            setFmTransferTasks((prev) =>
              prev.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      progress,
                      speed: speedMBs,
                      status: status === "completed" ? "completed" : status === "skipped" ? "completed" : "transferring",
                    }
                  : t
              )
            );
          }
        );
      } catch (err: any) {
        console.error("File transfer error:", err);
        setFmTransferTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, status: "failed" }
              : t
          )
        );
      }
    }
  };

  const handleCanvasDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCanvasDragging(true);
  };

  const handleCanvasDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCanvasDragging(false);
  };

  const handleCanvasDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCanvasDragging(false);

    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const allFiles: File[] = [];
      await traverseFileTree(e.dataTransfer.items, "", allFiles);
      if (allFiles.length > 0) {
        // Collect unique directory paths
        const dirSet = new Set<string>();
        for (const file of allFiles) {
          const relPath = (file as any)._relativePath;
          if (relPath) {
            dirSet.add(relPath);
          }
        }
        handleSendFiles(allFiles, targetDir, "skip", false, Array.from(dirSet));
      }
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleSendFiles(e.dataTransfer.files, targetDir, "skip", false);
    }
  };

  const bytesReceivedRef = useRef(0);
  const blockCounterRef = useRef(0);
  const statsStatusRef = useRef('');

  const getDeviceName = (id: string) => {
    const info = devices.find(d => d.id === id);
    return info?.name || id;
  };

  const handleReorder = async (deviceId: string, direction: 'up' | 'down') => {
    const sorted = [...devices].filter(d => d.added).sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex(d => d.id === deviceId);
    if (idx === -1) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
    const newOrder = sorted.map(d => d.id);
    try {
      await fetch(`${serverUrl}/api/v1/devices/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newOrder })
      });
      loadDevices();
    } catch (e) {
      console.error(e);
    }
  };

  // 拖拽排序完成后持久化顺序到服务端（服务端已写入 device_storage.json）
  const persistDeviceOrder = async (order: string[]) => {
    if (order.length === 0) return;
    try {
      await fetch(`${serverUrl}/api/v1/devices/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
      });
      loadDevices();
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemoveDevice = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await confirmDialog("确定要从列表中移除该离线设备吗？", { danger: true }))) return;
    try {
      await fetch(`${serverUrl}/api/v1/devices/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id })
      });
      loadDevices();
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddDevice = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`${serverUrl}/api/v1/devices/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id })
      });
      loadDevices();
    } catch (e) {
      console.error(e);
    }
  };

  const loadDevices = async () => {
    if (currentView === 'remote') return;
    setStatus("loading");
    try {
      const [allRes, discoveredRes] = await Promise.all([
        fetch(`${serverUrl}/api/v1/devices`),
        fetch(`${serverUrl}/api/v1/devices/discovered`)
      ]);
      if (!allRes.ok || !discoveredRes.ok) { throw new Error('API response not ok'); }
      const all = await allRes.json();
      const discovered = await discoveredRes.json();
      setServerReachable(true);
      // 防御性校验：确保 API 返回的是数组，防止非数组数据导致 .filter() 崩溃 → 空白页
      setDevices(Array.isArray(all) ? all : []);
      setDiscoveredDevices(Array.isArray(discovered) ? discovered : []);
    } catch (e) {
      console.error(e);
      setServerReachable(false);
      setDevices([]);
      setDiscoveredDevices([]);
    } finally {
      setStatus("disconnected");
    }
  };

  const handleDownloadAgent = async () => {
    try {
      // 显式传 server=<当前访问地址>，让 Hub 把可达的 LAN 地址注入 Agent 配置，
      // 避免经主机名/回环访问时注入不可达地址（修复：局域网其他电脑安装后连不上 Hub）。
      let serverHost = 'localhost:38921';
      try {
        serverHost = new URL(serverUrl).host;
      } catch { /* 保持默认 */ }
      const res = await fetch(`${serverUrl}/agents?server=${encodeURIComponent(serverHost)}`);
      if (!res.ok) throw new Error('下载失败');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'exhibition-agent.exe';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error(e);
      toast('Agent 下载失败，请确认服务端已编译 Agent', "error");
    }
  };

  useEffect(() => {
    loadDevices();
    const interval = setInterval(() => {
      if (currentView !== 'remote') loadDevices();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, serverUrl]);

  // 设备 id → 缩略图 URL（仅在线设备）。URL 以 thumbEpoch 作为缓存键：
  // 同一 epoch 内由 5 秒轮询触发的重渲染不再生成新 URL，缩略图不会被重复下载。
  const thumbMap = useMemo(() => {
    const map = new Map<string, string>();
    devices.forEach(d => {
      if (d.added && d.online) {
        map.set(d.id, `${serverUrl}/api/v1/devices/thumbnail?device_id=${d.id}&t=${thumbEpoch}`);
      }
    });
    return map;
  }, [devices, serverUrl, thumbEpoch]);

  // 缩略图周期刷新：每 10 秒更新 thumbEpoch，使缩略图 URL 变化以重新拉取最新画面（保活、接近实时）
  useEffect(() => {
    const interval = setInterval(() => {
      setThumbEpoch(Date.now());
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // 手动刷新：刷新设备列表并同时更新缩略图缓存键，让缩略图立即刷新
  const handleRefresh = () => {
    loadDevices();
    setThumbEpoch(Date.now());
  };

  const connectDevice = (deviceId: string, keepBackoff = false) => {
    if (!deviceId) return;

    // 新的一次连接意图：重置自动重连状态（自动重连时保留退避计数）
    userDisconnectRef.current = false;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (!keepBackoff) reconnectAttemptRef.current = 0;

    if (clientRef.current) {
      activeWsRef.current = null; // 旧连接即将被主动关闭，使其 onclose 不再触发自动重连
      clientRef.current.destroy();
    }

    statsStatusRef.current = '';
    setCurrentDeviceId(deviceId);
    setCurrentView("remote");
    setStatus("connecting");

    // We need to wait for the view to render the canvas before initializing the client
    if (connectTimerRef.current !== null) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = window.setTimeout(() => {
      connectTimerRef.current = null;
      if (!canvasRef.current || userDisconnectRef.current) return;
        clientRef.current = new ExhibitionRemoteClient(canvasRef.current, serverUrl, deviceId, (stats: any) => {
          if (stats.type === 'frame') {
            bytesReceivedRef.current += stats.byteLength || 0;
            if (stats.frameType === 0x01) blockCounterRef.current++;
            if (statsStatusRef.current !== 'connected') {
              statsStatusRef.current = 'connected';
              setStatus('connected');
            }
          } else if (stats.type === 'keyboard') {
            setKeyboardCaptured(stats.captured);
          } else if (stats.type === 'freeze') {
            if (statsStatusRef.current !== 'frozen') {
              statsStatusRef.current = 'frozen';
              setStatus('frozen');
              // 冻结后自动进入重连流程（scheduleReconnect 内部会去重）
              scheduleReconnect();
            }
          }
        });
        activeWsRef.current = clientRef.current.ws ?? null;
        // Override ws.onclose to mark transferring tasks as failed on disconnect
        if (clientRef.current?.ws) {
          const origOnClose = clientRef.current.ws.onclose;
          const ws = clientRef.current.ws;
          clientRef.current.ws.onclose = (e: CloseEvent) => {
            if (origOnClose) origOnClose.call(ws, e);
            setFmTransferTasks((prev) =>
              prev.map((t) =>
                t.status === "transferring"
                  ? { ...t, status: "failed", error: "网络中断" }
                  : t
              )
            );
            // 断线自动重连：仅当非用户主动断开、且该 ws 仍是当前活动连接时调度
            if (!userDisconnectRef.current && activeWsRef.current === ws) {
              scheduleReconnect();
            }
          };
        }
        setStatus("connected");
    }, 100);

    bytesReceivedRef.current = 0;
    blockCounterRef.current = 0;
    setRenderedFps(0);
    setReceivedFps(0);
  };

  // 自动重连：指数退避 1s→2s→4s→8s→16s→…→上限 30s
  const scheduleReconnect = () => {
    if (userDisconnectRef.current) return;          // 用户已主动断开，不再自动重连
    if (reconnectTimerRef.current !== null) return; // 已有待执行的定时器
    const deviceId = currentDeviceId;
    if (!deviceId) return;
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttemptRef.current);
    reconnectAttemptRef.current += 1;
    setStatus("reconnecting");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (userDisconnectRef.current) return;
      connectDevice(deviceId, true);
    }, delay);
  };

  // 手动重新连接：清除待执行重连并立即重建连接（保留当前设备与画质等设置）
  const handleReconnect = () => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    if (currentDeviceId) {
      connectDevice(currentDeviceId);
    }
  };

  const disconnectDevice = () => {
    // 用户主动断开：停止自动重连
    userDisconnectRef.current = true;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    activeWsRef.current = null;

    if (connectTimerRef.current !== null) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }

    if (clientRef.current) {
      clientRef.current.destroy();
    }
    clientRef.current = null;
    statsStatusRef.current = '';
    setStatus("disconnected");
    setCurrentDeviceId(null);
    setRenderedFps(0);
    setReceivedFps(0);
    setDataRate(0);
    setBlockCount(0);
    setResolution("--");
    setKeyboardCaptured(false);
    setCurrentView("devices");
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.log(err));
    }
  };

  useEffect(() => {
    if (currentView !== 'remote') return;

    const fpsTimer = setInterval(() => {
      if (clientRef.current) {
        setReceivedFps(clientRef.current.getReceivedFrameCount());
        setRenderedFps(clientRef.current.getRenderedFrameCount());
        clientRef.current.resetFrameCounters();
      }
    }, 1000);

    const dataRateTimer = setInterval(() => {
      setDataRate(Math.round(bytesReceivedRef.current / 1024));
      bytesReceivedRef.current = 0;
    }, 1000);

    const blockTimer = setInterval(() => {
      setBlockCount(blockCounterRef.current);
      blockCounterRef.current = 0;
    }, 1000);

    const resTimer = setInterval(() => {
      if (clientRef.current && clientRef.current.maxFullW > 0) {
        setResolution(`${clientRef.current.maxFullW}x${clientRef.current.maxFullH}`);
      }
    }, 2000);

    return () => {
      clearInterval(fpsTimer);
      clearInterval(dataRateTimer);
      clearInterval(blockTimer);
      clearInterval(resTimer);
      // 离开控制画面时关闭 WebSocket，通知 Hub 释放 Agent 资源
      if (clientRef.current) {
        clientRef.current.destroy();
        clientRef.current = null;
      }
    };
  }, [currentView]);

  // 离开 remote 视图时停止自动重连并清除重连定时器
  useEffect(() => {
    if (currentView !== 'remote') {
      userDisconnectRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      activeWsRef.current = null;
      if (connectTimerRef.current !== null) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
    }
  }, [currentView]);

  // 组件卸载时彻底停止自动重连
  useEffect(() => {
    return () => {
      userDisconnectRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (connectTimerRef.current !== null) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      activeWsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (currentView !== 'remote' || !clientRef.current) return;
    let v = 50;
    if (qualityMode === 'smooth') v = 30;
    else if (qualityMode === 'hd') v = 75;
    clientRef.current.setQuality(v);
  }, [qualityMode, currentView]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // ── Remote: shortcut help toggle (?) / close (Esc) ──
  useEffect(() => {
    if (currentView !== 'remote') return;
    const handleRemoteKeyDown = (e: KeyboardEvent) => {
      if ((e.key === '?' || (e.shiftKey && e.code === 'Slash')) && !keyboardCaptured) {
        setShortcutHelpOpen(prev => !prev);
      }
      if (e.key === 'Escape' && shortcutHelpOpen) {
        setShortcutHelpOpen(false);
      }
    };
    document.addEventListener('keydown', handleRemoteKeyDown);
    return () => document.removeEventListener('keydown', handleRemoteKeyDown);
  }, [currentView, keyboardCaptured, shortcutHelpOpen]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // 新建分组（本地持久化，空分组也会显示在侧边栏）
  const handleCreateGroup = async () => {
    const name = await promptDialog("请输入分组名称：");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (customGroups.includes(trimmed) || allGroups.some(g => g.name === trimmed)) {
      toast("该分组已存在", "error");
      return;
    }
    const updated = [...customGroups, trimmed];
    setCustomGroups(updated);
    localStorage.setItem("ur-custom-groups", JSON.stringify(updated));
    setSelectedGroup(trimmed);
  };

  // 删除分组：从本地移除 + 从所有设备 tags 中清除该标签
  const handleDeleteGroup = async (groupName: string) => {
    if (!(await confirmDialog(`确定要删除分组「${groupName}」吗？\n该分组下设备的此标签将被移除。`, { danger: true }))) return;
    const updated = customGroups.filter(g => g !== groupName);
    setCustomGroups(updated);
    localStorage.setItem("ur-custom-groups", JSON.stringify(updated));
    setExpandedGroups(prev => prev.filter(g => g !== groupName));
    const affected = devices.filter(d => d.added && (d.tags || []).includes(groupName));
    for (const device of affected) {
      const newTags = (device.tags || []).filter(t => t !== groupName);
      try {
        await fetch(`${serverUrl}/api/v1/devices/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: device.id, tags: newTags })
        });
      } catch (e) { console.error(e); }
    }
    if (selectedGroup === groupName) setSelectedGroup("all");
    loadDevices();
  };

  // 展开/收起侧栏分组：切换 expandedGroups 中该组名的存在性
  const toggleGroupExpanded = (name: string) => {
    setExpandedGroups(prev => {
      const next = prev.includes(name) ? prev.filter(g => g !== name) : [...prev, name];
      return next;
    });
  };

  // 切换设备的某个标签（modal 中点击 chip）
  const toggleEditingTag = (tag: string) => {
    const current = editingTags.split(",").map(t => t.trim()).filter(Boolean);
    const newTags = current.includes(tag)
      ? current.filter(t => t !== tag)
      : [...current, tag];
    setEditingTags(newTags.join(", "));
  };

  // 导出设备信息为 CSV
  const handleExportCSV = () => {
    const added = devices.filter(d => d.added);
    if (added.length === 0) { toast("暂无已添加设备可导出", "info"); return; }
    const escapeCSV = (val: string) => {
      const s = String(val ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = ["状态", "设备名称", "设备ID", "IP地址", "MAC地址", "操作系统", "CPU", "内存", "标签"];
    const rows = added.map(d => [
      d.online ? "在线" : "离线",
      d.name || "",
      d.id,
      d.ip ? d.ip.split(":")[0] : "",
      formatMac(d.mac),
      d.os || "",
      d.cpu || "",
      d.ram ? `${d.ram} GB` : "",
      (d.tags || []).join("; ")
    ].map(escapeCSV).join(","));
    const csv = "\uFEFF" + [headers.map(escapeCSV).join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    a.download = `设备信息_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openDeviceDetails = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const device = devices.find(d => d.id === id);
    setEditingDeviceId(id);
    setEditingName(device?.name || "");
    setEditingTags(device?.tags?.[0] || "");
    setModalOpen(true);
  };

  useEffect(() => {
    if (!modalOpen || !editingDeviceId) {
      setThumbnailUrl(null);
      return;
    }
    const device = devices.find(d => d.id === editingDeviceId);
    if (!device?.online) {
      setThumbnailUrl(null);
      return;
    }
    const url = `${serverUrl}/api/v1/devices/thumbnail?device_id=${editingDeviceId}&t=${Date.now()}`;
    fetch(url, { method: 'HEAD' })
      .then(res => res.ok ? setThumbnailUrl(url) : setThumbnailUrl(null))
      .catch(() => setThumbnailUrl(null));
  }, [modalOpen, editingDeviceId]);

  const saveDeviceDetails = async () => {
    if (!editingDeviceId) return;
    try {
      await fetch(`${serverUrl}/api/v1/devices/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: editingDeviceId, name: editingName.trim() })
      });
      await fetch(`${serverUrl}/api/v1/devices/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: editingDeviceId,
          tags: editingTags.split(",").map(t => t.trim()).filter(Boolean)
        })
      });
      setModalOpen(false);
      loadDevices();
    } catch (e) {
      console.error(e);
    }
  };

  // 电源控制状态：正在操作的设备 ID（用于禁用按钮防重复点击）
  const [powerBusyId, setPowerBusyId] = useState<string | null>(null);
  // 批量电源控制：选中的设备 id 集合 + 批量操作 busy 防重
  const [batchPowerSelected, setBatchPowerSelected] = useState<Set<string>>(new Set());
  const [batchPowerBusy, setBatchPowerBusy] = useState(false);

  // 离线设备远程开机（Wake-on-LAN）
  const handleWakeDevice = async (device: DeviceInfo) => {
    setPowerBusyId(device.id);
    try {
      const res = await fetch(`${serverUrl}/api/v1/devices/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: device.id })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        toast(`唤醒包已发送（${device.name || device.id}）。\n若电脑未开机，请确认对方 BIOS/网卡已开启 Wake-on-LAN 且与 Hub 在同一局域网。`, "success");
      } else {
        toast(`远程开机失败：${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      console.error('[Wake]', e);
      toast(`远程开机请求失败：${(e as Error)?.message || e}`, "error");
    } finally {
      setPowerBusyId(null);
    }
  };

  // 在线设备远程关机
  const handleShutdownDevice = async (device: DeviceInfo) => {
    if (!(await confirmDialog(`确认要关机设备「${device.name || device.id}」吗？`, { danger: true }))) return;
    setPowerBusyId(device.id);
    try {
      const res = await fetch(`${serverUrl}/api/v1/devices/system-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: device.id, action: 'shutdown' })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        toast(`已发送关机指令（${device.name || device.id}），设备即将关机。`, "success");
      } else {
        toast(`关机失败：${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      console.error('[Shutdown]', e);
      toast(`关机请求失败：${(e as Error)?.message || e}`, "error");
    } finally {
      setPowerBusyId(null);
    }
  };

  // 批量关机：对选中的在线设备逐台发送 system-config shutdown
  const handleBatchShutdown = async () => {
    if (batchPowerBusy) return;
    if (batchPowerSelected.size === 0) { toast('请先选择设备', "info"); return; }
    const selected = devices.filter(d => d.added && batchPowerSelected.has(d.id) && d.online);
    if (selected.length === 0) { toast('所选设备中没有在线设备', "info"); return; }
    if (!(await confirmDialog(`确认要对 ${selected.length} 台在线设备执行关机吗？`, { danger: true }))) return;
    setBatchPowerBusy(true);
    try {
      const results = await Promise.allSettled(selected.map(async (device) => {
        try {
          const res = await fetch(`${serverUrl}/api/v1/devices/system-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: device.id, action: 'shutdown' })
          });
          const data = await res.json().catch(() => ({}));
          return !!data.success;
        } catch (e) {
          console.error('[BatchShutdown]', device.id, e);
          return false;
        }
      }));
      const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
      toast(`关机完成：成功 ${success} 台，失败 ${results.length - success} 台`, success > 0 ? "success" : "error");
    } finally {
      setBatchPowerBusy(false);
    }
  };

  // 批量远程开机：对选中的离线设备逐台发送 wake（WOL 仅保证指令已发送）
  const handleBatchWake = async () => {
    if (batchPowerBusy) return;
    if (batchPowerSelected.size === 0) { toast('请先选择设备', "info"); return; }
    const selected = devices.filter(d => d.added && batchPowerSelected.has(d.id) && !d.online);
    if (selected.length === 0) { toast('所选设备中没有离线设备', "info"); return; }
    setBatchPowerBusy(true);
    try {
      const results = await Promise.allSettled(selected.map(async (device) => {
        try {
          const res = await fetch(`${serverUrl}/api/v1/devices/wake`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: device.id })
          });
          const data = await res.json().catch(() => ({}));
          return !!data.success;
        } catch (e) {
          console.error('[BatchWake]', device.id, e);
          return false;
        }
      }));
      const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
      toast(`远程开机指令已发送：成功 ${success} 台，失败 ${results.length - success} 台`, success > 0 ? "success" : "error");
    } finally {
      setBatchPowerBusy(false);
    }
  };

  const formatMac = (mac: string) => {
    if (!mac) return 'Unknown';
    return mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase().match(/.{1,2}/g)?.join(':') || 'Unknown';
  };

  const addedCount = useMemo(() => devices.filter(d => d.added).length, [devices]);
  const serverOnline = serverReachable || status === 'loading';

  let serverHost = "localhost:38921";
  try {
    const u = new URL(serverUrl);
    serverHost = u.host;
  } catch { serverHost = serverUrl.replace(/^https?:\/\//, ''); }

  const renderDeviceCard = (device: DeviceInfo, section: 'online' | 'offline' | 'discovered') => {
    const id = device.id;
    const displayName = device.name || "未命名设备";
    const osLower = (device.os || "").toLowerCase();
    const isWindows = osLower.includes('windows');
    const isMac = osLower.includes('darwin') || osLower.includes('mac');
    const isLinux = osLower.includes('linux');
    const isOnline = section === 'online';
    const isDiscovered = section === 'discovered';

    const deviceIcon = isWindows ? (
      <Monitor className="w-4 h-4" style={{ color: 'var(--ur-primary-400)' }} />
    ) : isMac ? (
      <Monitor className="w-4 h-4" style={{ color: 'var(--ur-primary-400)' }} />
    ) : isLinux ? (
      <Terminal className="w-4 h-4" style={{ color: 'var(--ur-state-warning)' }} />
    ) : (
      <Monitor className="w-4 h-4" style={{ color: 'var(--ur-primary-400)' }} />
    );

    const tagBadgeStyle = isOnline
      ? { background: 'rgba(16,185,129,0.1)', color: 'var(--ur-state-success)', borderColor: 'rgba(16,185,129,0.25)' }
      : isDiscovered
        ? { background: 'rgba(245,158,11,0.1)', color: 'var(--ur-state-warning)', borderColor: 'rgba(245,158,11,0.25)' }
        : { background: 'var(--ur-muted)', color: 'var(--ur-muted-foreground)', borderColor: 'var(--ur-border)' };

    // 遥测面板：顶部信号条颜色 / 状态胶囊样式 / 空态辉光色
    const signalColor = isOnline ? '#10b981' : isDiscovered ? '#f59e0b' : '#475569';
    const statusCapsuleStyle = isOnline
      ? { background: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.3)', color: 'var(--ur-state-success)' }
      : isDiscovered
        ? { background: 'rgba(245,158,11,0.12)', borderColor: 'rgba(245,158,11,0.3)', color: 'var(--ur-state-warning)' }
        : { background: 'rgba(100,116,139,0.12)', borderColor: 'rgba(100,116,139,0.3)', color: 'var(--ur-muted-foreground)' };
    const signalGlowColor = isOnline ? 'rgba(16,185,129,0.15)' : isDiscovered ? 'rgba(245,158,11,0.15)' : 'rgba(71,85,105,0.15)';

    return (
      <div
        key={id}
        draggable={!isDiscovered}
        onDragStart={(e) => { e.stopPropagation(); setDragDeviceId(id); }}
        onDragOver={(e) => {
          if (!dragDeviceId || dragDeviceId === id || isDiscovered) return;
          e.preventDefault(); // 允许放置
          setDragOverDeviceId(id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!dragDeviceId || dragDeviceId === id) return;
          const from = devices.findIndex(d => d.id === dragDeviceId);
          const to = devices.findIndex(d => d.id === id);
          if (from === -1 || to === -1 || from === to) return;
          const next = [...devices];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          setDevices(next);
          persistDeviceOrder(next.filter(d => d.added).map(d => d.id));
        }}
        onDragEnd={() => { setDragDeviceId(null); setDragOverDeviceId(null); }}
        className={`bg-card border border-border rounded-lg p-4 transition-all duration-200 group relative flex flex-col gap-3 overflow-hidden ${
          isOnline ? 'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-xl cursor-pointer' :
          isDiscovered ? 'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-xl cursor-pointer' :
          'opacity-60 cursor-default'
        } ${dragDeviceId === id ? 'opacity-40' : ''} ${dragOverDeviceId === id ? 'border-primary ring-2 ring-primary/25' : ''}`}
        onClick={() => { if (isOnline) connectDevice(id); }}
      >
        {/* 顶部状态信号条 */}
        <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: signalColor, boxShadow: isOnline ? '0 0 10px rgba(16,185,129,0.5)' : undefined }}></span>

        {/* Reorder buttons: left/right, matching horizontal grid flow */}
        {!isDiscovered && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handleReorder(id, 'up'); }}
              className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-md text-muted-foreground hover:text-foreground hover:border-primary/50 opacity-0 group-hover:opacity-100 transition-all z-10"
              title="左移"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleReorder(id, 'down'); }}
              className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-md text-muted-foreground hover:text-foreground hover:border-primary/50 opacity-0 group-hover:opacity-100 transition-all z-10"
              title="右移"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </>
        )}

        {/* Remove button for offline added devices */}
        {!isDiscovered && !isOnline && (
          <button
            onClick={(e) => handleRemoveDevice(id, e)}
            className="absolute top-2.5 right-2.5 w-6 h-6 flex items-center justify-center rounded-md bg-background/80 backdrop-blur-sm border border-border text-muted-foreground hover:text-error hover:border-error/50 opacity-0 group-hover:opacity-100 transition-opacity z-10"
            title="移除设备"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="relative flex items-start gap-3 pl-5">
          {/* 头部左上角蓝色径向辉光 */}
          <div className="pointer-events-none absolute -top-10 -left-10 w-40 h-40 rounded-full opacity-[0.08]" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.6), transparent 70%)' }}></div>
          <div
            className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-muted/60 border border-border/60 flex-shrink-0"
            style={isOnline ? { boxShadow: '0 0 0 1px rgba(16,185,129,0.25)' } : undefined}
          >
            {deviceIcon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold tracking-wide text-foreground truncate" title={displayName}>{displayName}</span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {device.tags && device.tags.length > 0 && (
                  <div className="flex items-center gap-1">
                    {device.tags.slice(0, 2).map((tag, i) => (
                      <span
                        key={i}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border whitespace-nowrap"
                        style={tagBadgeStyle}
                      >
                        {tag}
                      </span>
                    ))}
                    {device.tags.length > 2 && (
                      <span className="text-[10px] font-mono text-muted-foreground">+{device.tags.length - 2}</span>
                    )}
                  </div>
                )}
                {!isDiscovered && (
                  <button
                    onClick={(e) => openDeviceDetails(id, e)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-muted-foreground border border-border bg-muted/40 hover:text-foreground hover:border-primary/40 transition-colors flex-shrink-0"
                    title="设备详情"
                  >
                    <Settings className="w-3 h-3" /> 设置
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {/* 状态胶囊 */}
              <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono border" style={statusCapsuleStyle}>
                {isOnline ? (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="ur-ping absolute inline-flex h-full w-full rounded-full" style={{ background: 'var(--ur-state-success)' }}></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: 'var(--ur-state-success)' }}></span>
                  </span>
                ) : isDiscovered ? (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: 'var(--ur-state-warning)' }}></span>
                  </span>
                ) : (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: 'var(--ur-muted-foreground)' }}></span>
                  </span>
                )}
                {isOnline ? '在线' : isDiscovered ? '待添加' : '离线'}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground truncate">{device.ip ? device.ip.split(':')[0] : '--'}</span>
            </div>
          </div>
        </div>

        <div className="relative w-full aspect-video rounded-lg border border-border/70 overflow-hidden bg-[#05070d] ring-1 ring-inset ring-white/[0.06] flex items-center justify-center group/screen">
          {isOnline ? (
            <>
              <img
                src={thumbMap.get(id)}
                alt="Screen Thumbnail"
                draggable={false}
                className="w-full h-full object-cover opacity-75 transition-all duration-300 group-hover/screen:opacity-100 group-hover/screen:scale-[1.03]"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  img.style.display = 'none';
                  const parent = img.parentElement;
                  if (parent && !parent.querySelector('.thumbnail-fallback')) {
                    const fallback = document.createElement('div');
                    fallback.className = 'thumbnail-fallback text-muted-foreground flex flex-col items-center';
                    fallback.innerHTML = '<svg class="w-6 h-6 mb-1" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg><span class="text-[10px]">无缩略图</span></div>';
                    parent.appendChild(fallback);
                  }
                }}
                onLoad={(e) => {
                  // 恢复因之前加载失败被隐藏的图片，并移除占位：保证缩略图一旦可用（快照/新帧到达）即可显示
                  const img = e.target as HTMLImageElement;
                  img.style.display = '';
                  const parent = img.parentElement;
                  if (parent) {
                    const fb = parent.querySelector('.thumbnail-fallback');
                    if (fb) fb.remove();
                  }
                }}
              />
              {/* CRT 扫描线叠加层 */}
              <div className="pointer-events-none absolute inset-0" style={{ background: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 3px)' }}></div>
              {/* 顶部渐变遮罩 */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/60 to-transparent"></div>
              {/* LIVE 徽标（毛玻璃胶囊） */}
              <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-black/40 backdrop-blur-sm px-1.5 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#ef4444', boxShadow: '0 0 6px #ef4444' }}></span>
                <span className="text-[9px] font-mono tracking-[0.15em] text-white/80">LIVE</span>
              </div>
              {/* 悬停远程连接遮罩 */}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 opacity-0 group-hover/screen:opacity-100 transition-opacity backdrop-blur-[2px]" style={{ background: 'rgba(10,14,26,0.7)' }}>
                <Cast className="w-6 h-6" style={{ color: 'var(--ur-primary-300)' }} />
                <span className="text-xs font-medium text-foreground">远程连接</span>
              </div>
            </>
          ) : (
            /* 信号缺失空态 */
            <div className="flex flex-col items-center justify-center gap-2">
              <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: `radial-gradient(circle, ${signalGlowColor}, transparent 70%)` }}>
                <WifiOff className="w-5 h-5" style={{ color: signalColor }} />
              </div>
              <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">{isDiscovered ? '待添加' : '设备离线'}</span>
            </div>
          )}
        </div>

        {!isDiscovered && (
          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              disabled={!isOnline}
              onClick={(e) => {
                e.stopPropagation();
                if (isOnline) {
                  connectDevice(id);
                  setFileManagerOpen(true);
                  setFileManagerMinimized(false);
                }
              }}
              className={`flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium text-foreground bg-muted/40 border border-border hover:border-primary/40 hover:bg-muted/70 active:scale-[0.97] transition-all ${
                isOnline ? '' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <Folder className="w-3.5 h-3.5" /> 传文件
            </button>
            <button
              disabled={!isOnline}
              onClick={(e) => {
                e.stopPropagation();
                if (isOnline) setTerminalDevice({ id, name: displayName });
              }}
              className={`flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium text-foreground bg-muted/40 border border-border hover:border-primary/40 hover:bg-muted/70 active:scale-[0.97] transition-all ${
                isOnline ? '' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" /> 控制台
            </button>
          </div>
        )}

        {isDiscovered && (
          <button
            onClick={(e) => handleAddDevice(id, e)}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-semibold transition-all active:scale-[0.97]"
            style={{ background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)', boxShadow: '0 0 12px rgba(59,130,246,0.25)' }}
          >
            <Plus className="w-3.5 h-3.5" /> 添加设备
          </button>
        )}
      </div>
    );
  };

  const renderSection = (title: string, dotColor: string, countBadgeStyle: React.CSSProperties, devices: DeviceInfo[], sectionType: 'online' | 'offline' | 'discovered', emptyText: string, trailingText?: string) => {
    return (
      <div className="mb-8">
        <div className="flex items-center gap-2.5 mb-4">
          <span className="relative flex h-2.5 w-2.5">
            {sectionType === 'online' && (
              <span className="ur-ping absolute inline-flex h-full w-full rounded-full" style={{ background: dotColor }}></span>
            )}
            <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: dotColor }}></span>
          </span>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={countBadgeStyle}>{devices.length}台</span>
          <div className="flex-1 h-px bg-border ml-2"></div>
          {trailingText && <span className="text-[11px] font-mono text-muted-foreground">{trailingText}</span>}
        </div>
        {devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2 bg-card/30 rounded-md border border-border/50">
            <p className="text-sm">{emptyText}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {devices.map(device => renderDeviceCard(device, sectionType))}
          </div>
        )}
      </div>
    );
  };

  const renderSidebar = () => {
    const navItems: { key: AppView; label: string; icon: React.ReactNode }[] = [
      { key: 'devices', label: '设备管理', icon: <Monitor className="w-4 h-4 flex-shrink-0" /> },
      { key: 'device-info', label: '设备信息', icon: <Table className="w-4 h-4 flex-shrink-0" /> },
      { key: 'file-transfer', label: '文件传输', icon: <Folder className="w-4 h-4 flex-shrink-0" /> },
      { key: 'settings', label: '系统设置', icon: <Settings className="w-4 h-4 flex-shrink-0" /> },
    ];

    return (
      <aside className="app-sidebar flex flex-col bg-card border-r border-border">
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-md flex-shrink-0" style={{ background: 'var(--ur-primary-600)' }}>
            <Monitor className="w-4 h-4" style={{ color: '#ffffff' }} />
          </div>
          <div className="flex flex-col leading-tight min-w-0">
            <span className="text-sm font-semibold text-foreground truncate">展厅远程控制</span>
            <span className="text-[10px] font-mono text-muted-foreground">v2.0</span>
          </div>
        </div>

        {/* Primary nav */}
        <nav className="px-2 py-3 space-y-1 flex-shrink-0">
          {navItems.map(item => {
            const active = currentView === item.key;
            return (
              <a
                key={item.key}
                onClick={() => setCurrentView(item.key)}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors"
                style={active
                  ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' }
                  : { color: 'var(--ur-muted-foreground)' }}
              >
                {!active && <span className="hover:bg-muted hover:text-foreground transition-colors" />}
                {item.icon}
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="mx-3 my-1 border-t border-border flex-shrink-0"></div>

        {/* Device groups + discovered */}
        <div className="px-3 pt-2 pb-3 flex-1 min-h-0 overflow-y-auto">
          <div className="flex items-center justify-between px-1 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">设备分组</span>
            <button onClick={handleCreateGroup} className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="新建分组">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-1">
            <button
              onClick={() => setSelectedGroup("all")}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors"
              style={selectedGroup === "all"
                ? { background: 'var(--ur-muted)', color: 'var(--ur-foreground)' }
                : { color: 'var(--ur-muted-foreground)' }}
            >
              <span className="flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-muted-foreground" />
                全部设备
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border" style={{ background: 'var(--ur-card)' }}>{addedCount}</span>
            </button>
            {(() => {
              const ungroupedExpanded = expandedGroups.includes(UNGROUPED_GROUP);
              const ungroupedMembers = devices
                .filter(d => d.added && !(d.tags || []).length)
                .sort((a, b) => (a.online === b.online ? a.order - b.order : a.online ? -1 : 1));
              return (
                <div>
                  <div
                    className="group/ungrp flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-muted cursor-pointer"
                    style={selectedGroup === UNGROUPED_GROUP
                      ? { background: 'var(--ur-muted)', color: 'var(--ur-foreground)' }
                      : { color: 'var(--ur-muted-foreground)' }}
                    onClick={() => setSelectedGroup(UNGROUPED_GROUP)}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleGroupExpanded(UNGROUPED_GROUP); }}
                        className="flex items-center justify-center w-3.5 h-3.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        title={ungroupedExpanded ? "收起" : "展开"}
                      >
                        {ungroupedExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </button>
                      <FolderX className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      <span className="truncate">未分组</span>
                    </span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border" style={{ background: 'var(--ur-card)' }}>{ungroupedMembers.length}</span>
                    </span>
                  </div>
                  {ungroupedExpanded && (
                    <div className="pl-7 pr-2 py-1 space-y-0.5">
                      {ungroupedMembers.length === 0 ? (
                        <div className="text-[11px] text-muted-foreground italic px-2 py-1">（暂无设备）</div>
                      ) : ungroupedMembers.map(m => (
                        <button
                          key={m.id}
                          onClick={(e) => openDeviceDetails(m.id, e)}
                          className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] hover:bg-muted transition-colors text-left"
                        >
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: m.online ? 'var(--ur-state-success)' : 'var(--ur-muted-foreground)' }}></span>
                          <span className="truncate flex-1" style={{ color: m.online ? 'var(--ur-foreground)' : 'var(--ur-muted-foreground)' }}>{m.name || '未命名设备'}</span>
                          <span className="text-[10px] font-mono text-muted-foreground truncate">{m.ip ? m.ip.split(':')[0] : '--'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            {allGroups.map(group => {
              const expanded = expandedGroups.includes(group.name);
              const groupMembers = devices
                .filter(d => d.added && (d.tags || []).includes(group.name))
                .sort((a, b) => (a.online === b.online ? a.order - b.order : a.online ? -1 : 1));
              return (
                <div key={group.name}>
                  <div
                    className="group/grp flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-muted cursor-pointer"
                    style={selectedGroup === group.name
                      ? { background: 'var(--ur-muted)', color: 'var(--ur-foreground)' }
                      : { color: 'var(--ur-muted-foreground)' }}
                    onClick={() => setSelectedGroup(group.name)}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleGroupExpanded(group.name); }}
                        className="flex items-center justify-center w-3.5 h-3.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        title={expanded ? "收起" : "展开"}
                      >
                        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </button>
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: getGroupColor(group.name) }} title={`${group.count} 台设备`}></span>
                      <span className="truncate">{group.name}</span>
                    </span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border" style={{ background: 'var(--ur-card)' }}>{group.count}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group.name); }}
                        className="opacity-0 group-hover/grp:opacity-100 w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-error transition-opacity"
                        title="删除分组"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  </div>
                  {expanded && (
                    <div className="pl-7 pr-2 py-1 space-y-0.5">
                      {groupMembers.length === 0 ? (
                        <div className="text-[11px] text-muted-foreground italic px-2 py-1">（暂无设备）</div>
                      ) : groupMembers.map(m => (
                        <button
                          key={m.id}
                          onClick={(e) => openDeviceDetails(m.id, e)}
                          className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] hover:bg-muted transition-colors text-left"
                        >
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: m.online ? 'var(--ur-state-success)' : 'var(--ur-muted-foreground)' }}></span>
                          <span className="truncate flex-1" style={{ color: m.online ? 'var(--ur-foreground)' : 'var(--ur-muted-foreground)' }}>{m.name || '未命名设备'}</span>
                          <span className="text-[10px] font-mono text-muted-foreground truncate">{m.ip ? m.ip.split(':')[0] : '--'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Discovered Devices List */}
          <div className="mt-3 pt-3 border-t border-border">
            <div className="flex items-center justify-between px-1 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="ur-ping absolute inline-flex h-full w-full rounded-full" style={{ background: 'var(--ur-state-warning)' }}></span>
                  <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: 'var(--ur-state-warning)' }}></span>
                </span>
                发现新设备
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border" style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--ur-state-warning)', borderColor: 'rgba(245,158,11,0.25)' }}>{filteredDiscovered.length}</span>
            </div>
            <div className="space-y-1.5">
              {filteredDiscovered.length === 0 ? (
                <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">暂无新设备</div>
              ) : filteredDiscovered.map(device => (
                <div key={device.id} className="group p-2 rounded-md border bg-card transition-colors" style={{ borderColor: 'rgba(245,158,11,0.25)' }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="flex items-center justify-center w-6 h-6 rounded bg-muted flex-shrink-0">
                      <Monitor className="w-3 h-3" style={{ color: 'var(--ur-primary-400)' }} />
                    </div>
                    <span className="text-xs font-semibold text-foreground truncate flex-1">{device.name || "未命名设备"}</span>
                    <button onClick={(e) => handleAddDevice(device.id, e)} className="flex items-center justify-center w-5 h-5 rounded text-warning hover:bg-muted transition-colors flex-shrink-0" title="添加设备">
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground pl-8 space-y-0.5">
                    <div>{device.ip ? device.ip.split(':')[0] : '--'} · {device.os || 'Unknown'}</div>
                    <div className="text-warning">待添加 · 同一局域网</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Server connection status */}
        <div className="m-3 p-3 rounded-md bg-muted border border-border flex-shrink-0">
          <div className="flex items-center gap-2 mb-1.5">
            <Server className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">服务端</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                {serverOnline && <span className="ur-ping absolute inline-flex h-full w-full rounded-full" style={{ background: 'var(--ur-state-success)' }}></span>}
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: serverOnline ? 'var(--ur-state-success)' : 'var(--ur-muted-foreground)' }}></span>
              </span>
              <span className="text-[10px] font-mono" style={{ color: serverOnline ? 'var(--ur-state-success)' : 'var(--ur-muted-foreground)' }}>{serverOnline ? '已连接' : '未连接'}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
            <Network className="w-3 h-3" />
            <span>{serverHost}</span>
          </div>
        </div>
      </aside>
    );
  };

  const renderHeader = () => {
    if (currentView === 'devices') {
      return (
        <header className="app-header flex items-center gap-4 px-6 bg-card border-b border-border">
          <div className="flex flex-col leading-tight flex-shrink-0">
            <h1 className="text-base font-semibold text-foreground">我的设备</h1>
            <span className="text-[11px] text-muted-foreground">管理所有远程控制设备</span>
          </div>
          <div className="flex-1 max-w-xl mx-auto relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索设备名称、IP 或系统..."
              className="w-full h-9 pl-9 pr-3 rounded-md bg-muted border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors"
            />
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted border border-border">
              <span className="relative flex h-2 w-2">
                {serverOnline && <span className="ur-ping absolute inline-flex h-full w-full rounded-full" style={{ background: 'var(--ur-state-success)' }}></span>}
                <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: serverOnline ? 'var(--ur-state-success)' : 'var(--ur-muted-foreground)' }}></span>
              </span>
              <span className="text-xs font-medium text-foreground">{serverOnline ? '服务端已连接' : '服务端未连接'}</span>
            </div>
            <button onClick={handleRefresh} title="刷新设备列表" className="flex items-center justify-center w-9 h-9 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={handleDownloadAgent} className="flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium transition-opacity hover:opacity-90" style={{ background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' }}>
              <Download className="w-4 h-4" />
              <span>下载 Agent</span>
            </button>
          </div>
        </header>
      );
    }
    if (currentView === 'device-info') {
      return (
        <header className="app-header flex items-center gap-4 px-6 bg-card border-b border-border">
          <div className="flex flex-col leading-tight flex-shrink-0">
            <h1 className="text-base font-semibold text-foreground">设备信息总览</h1>
            <span className="text-[11px] text-muted-foreground">查看所有已添加设备的详细硬件信息</span>
          </div>
          <div className="flex-1"></div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={handleRefresh} className="flex items-center justify-center w-9 h-9 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground transition-colors" title="刷新">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={handleExportCSV} className="flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium transition-opacity hover:opacity-90" style={{ background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' }} title="导出为 CSV 文件">
              <FileDown className="w-4 h-4" />
              <span>导出 CSV</span>
            </button>
          </div>
        </header>
      );
    }
    if (currentView === 'file-transfer') {
      return (
        <header className="app-header flex items-center gap-4 px-6 bg-card border-b border-border">
          <div className="flex flex-col leading-tight flex-shrink-0">
            <h1 className="text-base font-semibold text-foreground">文件传输</h1>
            <span className="text-[11px] text-muted-foreground">管理设备间的文件传输任务</span>
          </div>
          <div className="flex-1"></div>
        </header>
      );
    }
    // settings
    return (
      <header className="app-header flex items-center gap-4 px-6 bg-card border-b border-border">
        <div className="flex flex-col leading-tight flex-shrink-0">
          <h1 className="text-base font-semibold text-foreground">系统设置</h1>
          <span className="text-xs text-muted-foreground">配置连接、画质、界面等系统参数</span>
        </div>
        <div className="flex-1"></div>
      </header>
    );
  };

  const renderDevicesView = () => {
    // 分组视图：单个分区的标题行 + 卡片网格（在线优先、同状态按 order 升序）
    const renderGroupedSection = (title: string, dotColor: string, groupDevices: DeviceInfo[]) => {
      const sorted = [...groupDevices].sort((a, b) => (a.online === b.online ? a.order - b.order : a.online ? -1 : 1));
      const onlineCount = sorted.filter(d => d.online).length;
      const offlineCount = sorted.length - onlineCount;
      return (
        <div className="mb-8">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: dotColor }}></span>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={{ background: 'var(--ur-muted)', color: 'var(--ur-muted-foreground)', borderColor: 'var(--ur-border)' }}>{sorted.length}台</span>
            <span className="text-[11px] font-mono text-muted-foreground">在线 {onlineCount} · 离线 {offlineCount}</span>
            <div className="flex-1 h-px bg-border ml-2"></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {sorted.map(device => renderDeviceCard(device, device.online ? 'online' : 'offline'))}
          </div>
        </div>
      );
    };

    // 分组视图：按当前分组筛选计算分区内容
    const renderGroupedContent = () => {
      const base = devices
        .filter(d => d.added)
        .filter(d => !q || d.name.toLowerCase().includes(q) || d.os.toLowerCase().includes(q) || d.ip.toLowerCase().includes(q));
      if (selectedGroup === "all") {
        const sections: React.ReactNode[] = [];
        allGroups.forEach(group => {
          const members = base.filter(d => (d.tags || []).includes(group.name));
          if (members.length > 0) sections.push(renderGroupedSection(group.name, getGroupColor(group.name), members));
        });
        const ungrouped = base.filter(d => !(d.tags || []).length);
        if (ungrouped.length > 0) sections.push(renderGroupedSection('未分组', 'var(--ur-muted-foreground)', ungrouped));
        if (sections.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <p className="text-sm">{q ? '未找到匹配设备' : '暂无设备'}</p>
            </div>
          );
        }
        return <>{sections}</>;
      }
      const isUngrouped = selectedGroup === UNGROUPED_GROUP;
      const members = isUngrouped
        ? base.filter(d => !(d.tags || []).length)
        : base.filter(d => (d.tags || []).includes(selectedGroup));
      if (members.length === 0) {
        return (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <p className="text-sm">{q ? '该分组暂无匹配设备' : '该分组暂无设备'}</p>
          </div>
        );
      }
      return renderGroupedSection(isUngrouped ? '未分组' : selectedGroup, isUngrouped ? 'var(--ur-muted-foreground)' : getGroupColor(selectedGroup), members);
    };

    return (
      <main className="app-scroll p-6 bg-background">
        <div className="max-w-[1400px] mx-auto">
          <div className="flex items-center justify-end mb-4">
            <div className="flex items-center bg-muted/50 rounded-lg border border-border p-1 gap-1">
              <button onClick={() => setDeviceViewMode('cards')} className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5" style={deviceViewMode === 'cards' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
                <LayoutGrid className="w-3.5 h-3.5" /> 卡片视图
              </button>
              <button onClick={() => setDeviceViewMode('grouped')} className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5" style={deviceViewMode === 'grouped' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
                <List className="w-3.5 h-3.5" /> 分组视图
              </button>
            </div>
          </div>
          {deviceViewMode === "cards" ? (
            <>
              {renderSection(
                '在线设备',
                'var(--ur-state-success)',
                { background: 'rgba(16,185,129,0.1)', color: 'var(--ur-state-success)', borderColor: 'rgba(16,185,129,0.25)' },
                onlineDevices,
                'online',
                searchQuery.trim() ? '未找到匹配的在线设备' : '暂无在线设备',
                '实时连接'
              )}
              {renderSection(
                '离线设备',
                'var(--ur-muted-foreground)',
                { background: 'var(--ur-muted)', color: 'var(--ur-muted-foreground)', borderColor: 'var(--ur-border)' },
                offlineDevices,
                'offline',
                searchQuery.trim() ? '未找到匹配的离线设备' : '暂无离线设备',
                '无法连接'
              )}
            </>
          ) : (
            renderGroupedContent()
          )}
        </div>
      </main>
    );
  };

  const renderDeviceInfoView = () => {
    const added = devices.filter(d => d.added);
    return (
      <main className="app-scroll bg-background">
        {batchPowerSelected.size > 0 && (
          <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
            <span className="text-xs font-medium text-foreground">已选 {batchPowerSelected.size} 台设备</span>
            <button
              onClick={handleBatchShutdown}
              disabled={batchPowerBusy}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity"
              style={{
                background: 'var(--ur-danger)',
                color: '#fff',
                cursor: batchPowerBusy ? 'not-allowed' : 'pointer',
                opacity: batchPowerBusy ? 0.5 : 1
              }}
              title="对选中的在线设备执行关机"
            >
              <Power className="w-3 h-3" />
              批量关机
            </button>
            <button
              onClick={handleBatchWake}
              disabled={batchPowerBusy}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-opacity"
              style={{
                background: 'var(--ur-state-success)',
                color: '#fff',
                cursor: batchPowerBusy ? 'not-allowed' : 'pointer',
                opacity: batchPowerBusy ? 0.5 : 1
              }}
              title="对选中的离线设备发送远程开机指令"
            >
              <Power className="w-3 h-3" />
              批量开机
            </button>
            <button
              onClick={() => setBatchPowerSelected(new Set())}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-muted border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              取消选择
            </button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full" style={{ minWidth: '1000px', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="px-3 py-2.5 text-left border-b border-border whitespace-nowrap" style={{ background: 'var(--ur-muted)', position: 'sticky', top: 0, zIndex: 10 }}>
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={added.length > 0 && added.every(d => batchPowerSelected.has(d.id))}
                    onChange={(e) => {
                      setBatchPowerSelected(e.target.checked ? new Set(added.map(d => d.id)) : new Set());
                    }}
                    title="全选已添加设备"
                  />
                </th>
                {['状态', '设备名称', '设备ID', 'IP地址', 'MAC地址', '操作系统', 'CPU', '内存', '标签', '操作'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap" style={{ background: 'var(--ur-muted)', position: 'sticky', top: 0, zIndex: 10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {added.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-sm text-muted-foreground">暂无已添加设备</td>
                </tr>
              ) : added.map(device => (
                <tr key={device.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="cursor-pointer"
                      checked={batchPowerSelected.has(device.id)}
                      onChange={() => {
                        setBatchPowerSelected(prev => {
                          const next = new Set(prev);
                          if (next.has(device.id)) next.delete(device.id);
                          else next.add(device.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: device.online ? 'var(--ur-state-success)' : 'var(--ur-muted-foreground)' }} title={device.online ? '在线' : '离线'}></span>
                  </td>
                  <td className="px-3 py-2.5 text-xs font-medium text-foreground whitespace-nowrap">{device.name || '未命名设备'}</td>
                  <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">
                    <span className="block truncate" style={{ maxWidth: 180 }} title={device.id}>{device.id}</span>
                  </td>
                  <td className="px-3 py-2.5 text-xs font-mono text-foreground whitespace-nowrap">{device.ip ? device.ip.split(':')[0] : '--'}</td>
                  <td className="px-3 py-2.5 text-xs font-mono text-foreground whitespace-nowrap">{formatMac(device.mac)}</td>
                  <td className="px-3 py-2.5 text-xs text-foreground whitespace-nowrap">{device.os || 'Unknown'}</td>
                  <td className="px-3 py-2.5 text-xs text-foreground">
                    <span className="block truncate" style={{ maxWidth: 200 }} title={device.cpu}>{device.cpu || 'Unknown'}</span>
                  </td>
                  <td className="px-3 py-2.5 text-xs font-mono text-foreground whitespace-nowrap">{device.ram ? `${device.ram} GB` : 'Unknown'}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {device.tags && device.tags.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {device.tags.map((tag, i) => {
                          const gColor = allGroups.some(g => g.name === tag) ? getGroupColor(tag) : 'var(--ur-muted-foreground)';
                          return <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border" style={{ background: `${gColor}18`, color: gColor, borderColor: `${gColor}44` }}>{tag}</span>;
                        })}
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground italic">(无)</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => setConfigPanelDevice({ id: device.id, name: device.name || device.id, online: device.online })}
                        className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-opacity"
                        style={{
                          background: device.online ? 'var(--ur-primary-600)' : 'var(--ur-muted)',
                          color: device.online ? '#fff' : 'var(--ur-muted-foreground)',
                          cursor: device.online ? 'pointer' : 'not-allowed',
                          opacity: device.online ? 1 : 0.5
                        }}
                        disabled={!device.online}
                      >
                        <Settings className="w-3 h-3" />
                        系统配置
                      </button>
                      {device.online ? (
                        <button
                          onClick={() => handleShutdownDevice(device)}
                          disabled={powerBusyId === device.id}
                          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-opacity"
                          style={{
                            background: 'var(--ur-danger)',
                            color: '#fff',
                            cursor: powerBusyId === device.id ? 'not-allowed' : 'pointer',
                            opacity: powerBusyId === device.id ? 0.5 : 1
                          }}
                          title="远程关机"
                        >
                          <Power className="w-3 h-3" />
                          {powerBusyId === device.id ? '关机中…' : '关机'}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleWakeDevice(device)}
                          disabled={powerBusyId === device.id}
                          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-opacity"
                          style={{
                            background: 'var(--ur-state-success)',
                            color: '#fff',
                            cursor: powerBusyId === device.id ? 'not-allowed' : 'pointer',
                            opacity: powerBusyId === device.id ? 0.5 : 1
                          }}
                          title="离线唤醒（远程开机）"
                        >
                          <Power className="w-3 h-3" />
                          {powerBusyId === device.id ? '发送中…' : '远程开机'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    );
  };

  // === 批量传输调度 ===
  // 单个文件真正发送（初次传输与失败重试共用）
  const sendBatchFile = useCallback(async (
    deviceId: string,
    deviceName: string,
    targetPath: string,
    file: File,
    overwriteMode: "skip" | "overwrite" | "rename",
    taskId: string
  ) => {
    const client = new FileTransferClient(serverUrl, deviceId);
    try {
      await client.waitOpen(15000);
      await client.sendFile(
        file,
        targetPath,
        { overwrite: overwriteMode },
        (progress: number, speedMBs: number, status: string) => {
          setFmTransferTasks((prev) =>
            prev.map((t) =>
              t.id === taskId
                ? {
                    ...t,
                    progress,
                    speed: speedMBs,
                    status: status === "completed" ? "completed" : "transferring",
                  }
                : t
            )
          );
        }
      );
      // 兜底：sendFile 正常返回后确保任务标记为完成
      setFmTransferTasks((prev) =>
        prev.map((t) =>
          t.id === taskId && t.status !== "completed"
            ? { ...t, status: "completed", progress: 100 }
            : t
        )
      );
    } catch (err: any) {
      console.error(`[BatchTransfer] Failed to send ${file.name} to ${deviceName}:`, err);
      setFmTransferTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, status: "failed", error: err?.message || "传输失败" }
            : t
        )
      );
    } finally {
      client.destroy();
    }
  }, [serverUrl, setFmTransferTasks]);

  const handleBatchTransfer = useCallback(async () => {
    const selectedIds = Array.from(batchSelectedDevices) as string[];
    const files = batchPendingFiles;
    if (selectedIds.length === 0 || files.length === 0) return;

    setBatchTransferring(true);
    const MAX_CONCURRENT = 3;

    // Transfer files to a single device
    const transferToDevice = async (deviceId: string) => {
      const deviceName = getDeviceName(deviceId);
      const targetPath = batchDevicePaths[deviceId] || batchGlobalTargetPath;
      const client = new FileTransferClient(serverUrl, deviceId);

      try {
        await client.waitOpen(15000);

        for (const file of files) {
          const taskId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const newTask: TransferTaskItem = {
            id: taskId,
            direction: "upload",
            name: file.name,
            size: file.size,
            sourcePath: "本机",
            targetPath: targetPath,
            progress: 0,
            speed: 0,
            status: "transferring",
            deviceId,
            deviceName,
          };

          // 保存 File 引用，供失败后重试真正重发
          batchTaskFilesRef.current.set(taskId, file);
          setFmTransferTasks((prev) => [newTask, ...prev]);

          await sendBatchFile(deviceId, deviceName, targetPath, file, batchOverwriteMode, taskId);
        }
      } catch (err: any) {
        console.error(`[BatchTransfer] Failed to connect to ${deviceName}:`, err);
        // Mark all files for this device as failed
        for (const file of files) {
          const taskId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          // 连接失败创建的任务同样保存 File 引用，供重试
          batchTaskFilesRef.current.set(taskId, file);
          setFmTransferTasks((prev) => [
            {
              id: taskId,
              direction: "upload",
              name: file.name,
              size: file.size,
              sourcePath: "本机",
              targetPath: targetPath,
              progress: 0,
              speed: 0,
              status: "failed",
              error: `设备 ${deviceName} 连接失败: ${err?.message || "未知错误"}`,
              deviceId,
              deviceName,
            },
            ...prev,
          ]);
        }
      } finally {
        client.destroy();
      }
    };

    // Process devices in batches of MAX_CONCURRENT
    for (let i = 0; i < selectedIds.length; i += MAX_CONCURRENT) {
      const batch = selectedIds.slice(i, i + MAX_CONCURRENT);
      await Promise.all(batch.map((id) => transferToDevice(id)));
    }

    setBatchTransferring(false);
  }, [batchSelectedDevices, batchPendingFiles, batchGlobalTargetPath, batchDevicePaths, serverUrl, getDeviceName, sendBatchFile, batchOverwriteMode]);

  const renderFileTransferView = () => {
    const onlineDevicesForTransfer = devices.filter(d => d.online);
    const offlineDevicesForTransfer = devices.filter(d => !d.online);
    const selectedCount = batchSelectedDevices.size;

    // Active tasks from ALL sources (batch + old FileManager)
    const transferring = fmTransferTasks.filter(t => t.status === 'transferring' || t.status === 'pending');
    const completed = fmTransferTasks.filter(t => t.status === 'completed');
    const failed = fmTransferTasks.filter(t => t.status === 'failed');
    const hasActiveTasks = transferring.length > 0;

    const formatSize = (bytes: number) => {
      if (!bytes) return '--';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    };

    // Task action helpers
    const handleCancelTask = (taskId: string) => {
      setFmTransferTasks(prev => prev.map(t => t.id === taskId && (t.status === 'transferring' || t.status === 'pending') ? { ...t, status: 'failed', error: '已取消' } : t));
      clientRef.current?.cancelTransfer?.();
    };

    const handleRetryTask = (taskId: string) => {
      const task = fmTransferTasks.find(t => t.id === taskId);
      const file = batchTaskFilesRef.current.get(taskId);
      if (!task || !file) {
        toast('文件引用已失效，请重新添加文件后重试', "error");
        return;
      }
      setFmTransferTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'transferring', progress: 0, error: undefined } : t));
      // 真正重发：复用原任务的设备、目标路径与 File 引用，沿用当前覆盖策略
      sendBatchFile(task.deviceId || '', task.deviceName || '', task.targetPath, file, batchOverwriteMode, taskId);
    };

    const handleRemoveTask = (taskId: string) => {
      setFmTransferTasks(prev => prev.filter(t => t.id !== taskId));
    };

    const handleClearCompleted = () => {
      setFmTransferTasks(prev => prev.filter(t => t.status !== 'completed'));
    };

    const handleClearFailed = () => {
      setFmTransferTasks(prev => prev.filter(t => t.status !== 'failed'));
    };

    const totalPendingSize = batchPendingFiles.reduce((sum, f) => sum + f.size, 0);

    const filteredOnlineDevices = onlineDevicesForTransfer.filter(d =>
      (d.name || d.id).toLowerCase().includes(batchDeviceSearch.trim().toLowerCase())
    );

    const allFilteredSelected = filteredOnlineDevices.length > 0 && filteredOnlineDevices.every(d => batchSelectedDevices.has(d.id));

    const globalProgress = fmTransferTasks.length > 0
      ? fmTransferTasks.reduce((sum, t) => sum + (t.progress || 0), 0) / fmTransferTasks.length
      : 0;

    const renderTaskCard = (task: TransferTaskItem) => (
      <div key={task.id} className="bg-card border border-border rounded-md p-3">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-muted flex-shrink-0 mt-0.5">
            {task.direction === 'upload' ? <UploadCloud className="w-4 h-4" style={{ color: 'var(--ur-primary-400)' }} /> : <Download className="w-4 h-4" style={{ color: 'var(--ur-primary-400)' }} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-foreground truncate">{task.name}</span>
              <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0">{formatSize(task.size)}</span>
              {task.deviceName && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--ur-primary-600)', borderColor: 'rgba(37,99,235,0.2)' }}>{task.deviceName}</span>
              )}
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-1">
              <div className="h-full rounded-full transition-all" style={{ width: `${task.progress || 0}%`, background: task.status === 'failed' ? 'var(--ur-state-error)' : task.status === 'completed' ? 'var(--ur-state-success)' : 'var(--ur-primary-600)' }} />
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-muted-foreground truncate max-w-[200px]">{task.targetPath}</span>
                {task.status === 'transferring' && <span className="font-mono text-success flex-shrink-0">{task.speed ? `${task.speed.toFixed(1)} MB/s` : '--'}</span>}
                {task.status === 'failed' && <span className="flex items-center gap-1 text-error flex-shrink-0"><XCircle className="w-3 h-3" />{task.error || '传输失败'}</span>}
                {task.status === 'completed' && <span className="flex items-center gap-1 text-success flex-shrink-0"><CheckCircle2 className="w-3 h-3" />完成</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {(task.status === 'transferring' || task.status === 'pending') && (
                  <button
                    onClick={() => handleCancelTask(task.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] text-muted-foreground hover:bg-muted hover:text-error transition-colors"
                    title="取消"
                  >
                    <X className="w-3 h-3" />取消
                  </button>
                )}
                {task.status === 'failed' && (
                  <button
                    onClick={() => handleRetryTask(task.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] text-muted-foreground hover:bg-muted hover:text-primary transition-colors"
                    title="重试"
                  >
                    <RotateCw className="w-3 h-3" />重试
                  </button>
                )}
                {(task.status === 'completed' || task.status === 'failed') && (
                  <button
                    onClick={() => handleRemoveTask(task.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] text-muted-foreground hover:bg-muted hover:text-error transition-colors"
                    title="移除"
                  >
                    <Trash2 className="w-3 h-3" />移除
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );

    const renderTaskList = () => {
      if (fmTransferTasks.length === 0) {
        return (
          <div className="flex flex-col items-center gap-3 text-muted-foreground py-8">
            <Folder className="w-10 h-10 opacity-30" />
            <p className="text-sm">暂无传输任务</p>
            <p className="text-xs opacity-60">选择设备和文件后，点击"开始传输"发起批量传输</p>
          </div>
        );
      }

      return (
        <div className="space-y-5">
          {hasActiveTasks && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>全局进度</span>
                <span>{Math.round(globalProgress)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${globalProgress}%`, background: 'var(--ur-primary-600)' }} />
              </div>
            </div>
          )}
          {transferring.length > 0 && (
            <section>
              <div className="flex items-center gap-2.5 mb-3">
                <Activity className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">进行中</h2>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--ur-primary-600)', borderColor: 'rgba(37,99,235,0.25)' }}>{transferring.length}</span>
                <div className="flex-1 h-px bg-border ml-2"></div>
              </div>
              <div className="space-y-2">{transferring.map(renderTaskCard)}</div>
            </section>
          )}
          {completed.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <h2 className="text-sm font-semibold text-foreground">已完成</h2>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={{ background: 'rgba(16,185,129,0.1)', color: 'var(--ur-state-success)', borderColor: 'rgba(16,185,129,0.25)' }}>{completed.length}</span>
                  <div className="flex-1 h-px bg-border ml-2"></div>
                </div>
                <button
                  onClick={handleClearCompleted}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] text-muted-foreground hover:bg-muted hover:text-error transition-colors"
                >
                  <Trash2 className="w-3 h-3" />清除已完成
                </button>
              </div>
              <div className="space-y-2">{completed.map(renderTaskCard)}</div>
            </section>
          )}
          {failed.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <FileWarning className="w-4 h-4 text-error" />
                  <h2 className="text-sm font-semibold text-foreground">传输失败</h2>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--ur-state-error)', borderColor: 'rgba(239,68,68,0.25)' }}>{failed.length}</span>
                  <div className="flex-1 h-px bg-border ml-2"></div>
                </div>
                <button
                  onClick={handleClearFailed}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] text-muted-foreground hover:bg-muted hover:text-error transition-colors"
                >
                  <Trash2 className="w-3 h-3" />清除失败
                </button>
              </div>
              <div className="space-y-2">{failed.map(renderTaskCard)}</div>
            </section>
          )}
        </div>
      );
    };

    return (
      <main className="app-scroll p-6 space-y-5 bg-background">
        {/* Global stats dashboard */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-md p-3 flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-md flex-shrink-0" style={{ background: 'rgba(37,99,235,0.1)' }}>
              <Monitor className="w-4 h-4" style={{ color: 'var(--ur-primary-600)' }} />
            </div>
            <div>
              <div className="text-lg font-semibold text-foreground leading-none">{selectedCount}</div>
              <div className="text-[11px] text-muted-foreground mt-1">选中设备</div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-3 flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-md flex-shrink-0" style={{ background: 'rgba(37,99,235,0.1)' }}>
              <Folder className="w-4 h-4" style={{ color: 'var(--ur-primary-600)' }} />
            </div>
            <div>
              <div className="text-lg font-semibold text-foreground leading-none">{batchPendingFiles.length}</div>
              <div className="text-[11px] text-muted-foreground mt-1">待传文件</div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-3 flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-md flex-shrink-0" style={{ background: 'rgba(37,99,235,0.1)' }}>
              <Activity className="w-4 h-4" style={{ color: 'var(--ur-primary-600)' }} />
            </div>
            <div>
              <div className="text-lg font-semibold text-foreground leading-none">{transferring.length}</div>
              <div className="text-[11px] text-muted-foreground mt-1">传输中</div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-3 flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-md flex-shrink-0" style={{ background: 'rgba(16,185,129,0.1)' }}>
              <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--ur-state-success)' }} />
            </div>
            <div>
              <div className="text-lg font-semibold text-foreground leading-none">{completed.length}<span className="text-[11px] text-muted-foreground font-normal mx-1">/</span><span className="text-base font-medium" style={{ color: 'var(--ur-state-error)' }}>{failed.length}</span></div>
              <div className="text-[11px] text-muted-foreground mt-1">已完成 / 失败</div>
            </div>
          </div>
        </div>

        {/* Two-column workspace: devices+paths | files */}
        <div className="flex flex-col lg:flex-row gap-4 items-stretch">
          {/* Column 1: Device Selection + Target Path (Combined) */}
          <section className="lg:flex-[3] min-w-0 bg-card border border-border rounded-md p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <Monitor className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">目标设备</h3>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--ur-primary-600)', borderColor: 'rgba(37,99,235,0.25)' }}>{selectedCount} 台</span>
            </div>
            <input
              type="text"
              value={batchDeviceSearch}
              onChange={(e) => setBatchDeviceSearch(e.target.value)}
              placeholder="搜索设备名称..."
              className="w-full px-2.5 py-1.5 text-xs rounded border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 mb-2"
            />
            {/* Default target path */}
            <div className="flex items-center gap-2 mb-3 px-1">
              <label className="text-[11px] text-muted-foreground whitespace-nowrap flex items-center gap-1.5">
                <Folder className="w-3.5 h-3.5" />
                默认路径
              </label>
              <input
                type="text"
                className="flex-1 px-2.5 py-1.5 text-xs rounded border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 font-mono"
                value={batchGlobalTargetPath}
                onChange={(e) => setBatchGlobalTargetPath(e.target.value)}
                placeholder="D:\"
              />
            </div>
            {onlineDevicesForTransfer.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center flex-1">暂无在线设备</div>
            ) : (
              <>
                <div className="flex-1 overflow-y-auto pr-1 max-h-[360px] space-y-1.5">
                {filteredOnlineDevices.map(d => {
                    const isSelected = batchSelectedDevices.has(d.id);
                    const hasOverride = !!batchDevicePaths[d.id];
                    return (
                      <label
                        key={d.id}
                        className={`flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors ${isSelected ? 'border-primary/30' : 'border-transparent hover:bg-muted'}`}
                        style={isSelected ? { background: 'rgba(37,99,235,0.05)' } : { background: 'transparent' }}
                      >
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 rounded flex-shrink-0"
                          style={{ accentColor: 'var(--ur-primary-600)' }}
                          checked={isSelected}
                          onChange={() => {
                            setBatchSelectedDevices(prev => {
                              const next = new Set(prev);
                              if (next.has(d.id)) { next.delete(d.id); } else { next.add(d.id); }
                              return next;
                            });
                          }}
                        />
                        <Monitor className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        <span className={`text-xs font-medium truncate w-24 flex-shrink-0 ${hasOverride ? 'text-primary' : 'text-foreground'}`} title={d.name || d.id}>{d.name || d.id}</span>
                        {isSelected ? (
                          <>
                            <div className="w-px h-4 bg-border flex-shrink-0" />
                            <span className="flex-1 min-w-0 flex items-center gap-1.5">
                              <Folder className={`w-3 h-3 flex-shrink-0 ${hasOverride ? 'text-primary' : 'text-muted-foreground'}`} />
                              <span
                                className="truncate font-mono text-[11px] flex-1 min-w-0"
                                style={{ color: hasOverride ? 'var(--ur-primary)' : 'var(--ur-muted-foreground)' }}
                                title={batchDevicePaths[d.id] || batchGlobalTargetPath || 'D:\\'}
                              >
                                {batchDevicePaths[d.id] || batchGlobalTargetPath || 'D:\\'}
                              </span>
                            </span>
                            <button
                              className="p-1 rounded hover:bg-muted flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => setBatchPickerDeviceId(d.id)}
                              title={`浏览 ${d.name || d.id} 的远程目录（选择或新建文件夹）`}
                            >
                              <FolderOpen className="w-3.5 h-3.5" />
                            </button>
                            {hasOverride && (
                              <button
                                className="p-1 rounded hover:bg-muted flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                                onClick={() => setBatchDevicePaths(prev => { const n = { ...prev }; delete n[d.id]; return n; })}
                                title="恢复默认路径 D:\\"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="flex-1 min-w-0"></span>
                        )}
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--ur-state-success)' }}></span>
                      </label>
                    );
                  })}
                </div>

                {/* ── 单独设备路径：独立模态目录选择器（点击「浏览」才弹出） ── */}
                {batchPickerDeviceId && (() => {
                  const pickDev = devices.find(x => x.id === batchPickerDeviceId);
                  return (
                    <RemoteDirPicker
                      serverUrl={serverUrl}
                      deviceId={batchPickerDeviceId}
                      deviceName={pickDev?.name || batchPickerDeviceId}
                      value={batchDevicePaths[batchPickerDeviceId] || batchGlobalTargetPath || "D:\\"}
                      onSelect={(dir) => {
                        setBatchDevicePaths(prev => {
                          const next = { ...prev };
                          if (dir) { next[batchPickerDeviceId] = dir; } else { delete next[batchPickerDeviceId]; }
                          return next;
                        });
                        setBatchPickerDeviceId(null);
                      }}
                      onClose={() => setBatchPickerDeviceId(null)}
                    />
                  );
                })()}

                {offlineDevicesForTransfer.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
                      离线设备 ({offlineDevicesForTransfer.length})
                    </summary>
                    <div className="mt-1.5 space-y-1 max-h-[120px] overflow-y-auto pr-1">
                      {offlineDevicesForTransfer.map(d => (
                        <div key={d.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-muted/30 text-muted-foreground/60">
                          <Monitor className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="text-xs truncate flex-1">{d.name || d.id}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </section>

          {/* Column 2: File Selection */}
          <section className="lg:flex-[2] min-w-0 bg-card border border-border rounded-md p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <Folder className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">待传文件</h3>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full border" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--ur-primary-600)', borderColor: 'rgba(37,99,235,0.25)' }}>{batchPendingFiles.length} 个</span>
            </div>
            <div
              className="border-2 border-dashed rounded-md p-5 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-primary/5 flex-shrink-0"
              style={{ borderColor: 'var(--ur-border)' }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  const newFiles = Array.from(e.dataTransfer.files) as File[];
                  setBatchPendingFiles(prev => {
                    const existing = new Set(prev.map(f => `${f.name}_${f.size}`));
                    const unique = newFiles.filter(f => !existing.has(`${f.name}_${f.size}`));
                    return [...prev, ...unique];
                  });
                }
              }}
              onClick={() => document.getElementById('batch-file-input')?.click()}
            >
              <UploadCloud className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground">拖拽文件到此处，或点击选择文件</p>
              <input
                type="file"
                multiple
                className="hidden"
                id="batch-file-input"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    const newFiles = Array.from(e.target.files) as File[];
                    setBatchPendingFiles(prev => {
                      const existing = new Set(prev.map(f => `${f.name}_${f.size}`));
                      const unique = newFiles.filter(f => !existing.has(`${f.name}_${f.size}`));
                      return [...prev, ...unique];
                    });
                  }
                  e.target.value = '';
                }}
              />
            </div>
            {batchPendingFiles.length > 0 && (
              <>
                <div className="mt-3 space-y-1 max-h-[240px] overflow-y-auto pr-1 flex-1 min-h-0">
                  {batchPendingFiles.map((f, i) => (
                    <div key={`${f.name}_${f.size}_${i}`} className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/50 text-xs">
                      <File className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-foreground truncate flex-1">{f.name}</span>
                      <span className="text-muted-foreground flex-shrink-0">{formatSize(f.size)}</span>
                      <button
                        className="p-0.5 rounded hover:bg-muted flex-shrink-0"
                        onClick={() => setBatchPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                      >
                        <X className="w-3 h-3 text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>共 {batchPendingFiles.length} 个文件</span>
                  <span className="font-mono">{formatSize(totalPendingSize)}</span>
                </div>
              </>
            )}
          </section>
        </div>

        {/* Bottom action bar */}
        <div className="sticky bottom-0 bg-card border border-border rounded-md p-3 flex items-center justify-between z-10 shadow-sm">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Monitor className="w-3.5 h-3.5" />{selectedCount} 台设备</span>
            <span className="flex items-center gap-1"><Folder className="w-3.5 h-3.5" />{batchPendingFiles.length} 个文件</span>
            <span className="font-mono">{formatSize(totalPendingSize)}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-muted border border-border" title="目标路径存在同名文件时的处理策略">
              <span className="text-xs text-muted-foreground">重名文件</span>
              <select
                value={batchOverwriteMode}
                onChange={(e) => setBatchOverwriteMode(e.target.value as "skip" | "overwrite" | "rename")}
                className="bg-transparent text-xs text-foreground outline-none cursor-pointer"
              >
                <option value="skip">跳过</option>
                <option value="overwrite">覆盖</option>
                <option value="rename">自动重命名</option>
              </select>
            </div>
            <button
              onClick={() => setBatchPendingFiles([])}
              disabled={batchPendingFiles.length === 0 || batchTransferring}
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-border transition-colors"
              style={{
                background: 'var(--ur-muted)',
                color: 'var(--ur-muted-foreground)',
                cursor: batchPendingFiles.length > 0 && !batchTransferring ? 'pointer' : 'not-allowed',
                opacity: batchPendingFiles.length > 0 && !batchTransferring ? 1 : 0.5
              }}
            >
              清空
            </button>
            <button
              disabled={selectedCount === 0 || batchPendingFiles.length === 0 || batchTransferring}
              className="flex items-center gap-2 px-5 py-2 rounded-md text-sm font-medium transition-all"
              style={{
                background: (selectedCount > 0 && batchPendingFiles.length > 0 && !batchTransferring) ? 'var(--ur-primary-600)' : 'var(--ur-muted)',
                color: (selectedCount > 0 && batchPendingFiles.length > 0 && !batchTransferring) ? '#fff' : 'var(--ur-muted-foreground)',
                cursor: (selectedCount > 0 && batchPendingFiles.length > 0 && !batchTransferring) ? 'pointer' : 'not-allowed',
                opacity: (selectedCount > 0 && batchPendingFiles.length > 0 && !batchTransferring) ? 1 : 0.5,
              }}
              onClick={handleBatchTransfer}
            >
              <UploadCloud className="w-4 h-4" />
              {batchTransferring ? '传输中...' : '开始传输'}
            </button>
          </div>
        </div>

        {/* Task list */}
        <div className="border-t border-border pt-5">{renderTaskList()}</div>
      </main>
    );
  };

  const renderSettingsView = () => {
    const SettingCard = ({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }) => (
      <section className="bg-card border border-border rounded-md">
        <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border">
          <div className="flex items-center justify-center w-7 h-7 rounded bg-muted flex-shrink-0">{icon}</div>
          <div className="flex flex-col leading-tight">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <span className="text-xs text-muted-foreground">{desc}</span>
          </div>
        </div>
        <div className="px-5 py-4 space-y-4">{children}</div>
      </section>
    );

    return (
      <main className="app-scroll p-6 bg-background">
        <div className="max-w-3xl mx-auto space-y-5">
          <SettingCard icon={<Network className="w-4 h-4 text-muted-foreground" />} title="连接设置" desc="服务端地址与重连策略">
            <div className="flex items-center gap-4">
              <label className="text-sm text-foreground w-28 flex-shrink-0">服务端地址</label>
              <input type="text" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} className="flex-1 h-9 px-3 rounded-md bg-background border border-border text-sm font-mono text-foreground focus:outline-none focus:border-primary transition-colors" />
            </div>
          </SettingCard>

          <SettingCard icon={<ImageIcon className="w-4 h-4 text-muted-foreground" />} title="画质设置" desc="远程画面渲染参数">
            <div className="flex items-center gap-4">
              <label className="text-sm text-foreground w-28 flex-shrink-0">默认画质模式</label>
              <div className="flex items-center bg-muted border border-border rounded-md p-1 gap-1">
                <button onClick={() => setQualityMode('smooth')} className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5" style={qualityMode === 'smooth' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
                  <Zap className="w-3.5 h-3.5" /> 流畅
                </button>
                <button onClick={() => setQualityMode('balanced')} className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5" style={qualityMode === 'balanced' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
                  <Activity className="w-3.5 h-3.5" /> 均衡
                </button>
                <button onClick={() => setQualityMode('hd')} className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5" style={qualityMode === 'hd' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
                  <ImageIcon className="w-3.5 h-3.5" /> 高清
                </button>
              </div>
            </div>
          </SettingCard>

          <SettingCard icon={<SlidersHorizontal className="w-4 h-4 text-muted-foreground" />} title="界面设置" desc="主题外观">
            <div className="flex items-center gap-4">
              <label className="text-sm text-foreground w-28 flex-shrink-0">主题模式</label>
              <div className="flex items-center gap-2">
                <button onClick={() => setTheme("dark")} className="h-9 px-4 rounded-md text-sm font-medium transition-opacity hover:opacity-90" style={theme === "dark" ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { background: 'transparent', color: 'var(--ur-muted-foreground)', border: '1px solid var(--ur-border)' }}>暗色</button>
                <button onClick={() => setTheme("light")} className="h-9 px-4 rounded-md text-sm font-medium transition-colors" style={theme === "light" ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { background: 'var(--ur-muted)', color: 'var(--ur-muted-foreground)', border: '1px solid var(--ur-border)' }}>亮色</button>
              </div>
            </div>
          </SettingCard>
        </div>
      </main>
    );
  };

  const renderRemoteView = () => (
    <div ref={containerRef} className="flex-1 flex flex-col h-full bg-black relative">
      {/* Top Floating Toolbar */}
      <div className="absolute top-0 left-0 right-0 h-14 bg-popover/90 backdrop-blur-md border-b border-border z-40 flex items-center justify-between px-4 pointer-events-auto" style={{ opacity: isFullscreen ? undefined : 1 }}>
        <div className="flex items-center gap-4">
          <button onClick={disconnectDevice} className="p-2 hover:bg-muted rounded-lg text-foreground transition-colors flex items-center gap-2">
            <ChevronLeft className="w-5 h-5" />
            <span className="font-bold text-sm">返回</span>
          </button>
          <div className="h-6 w-px bg-border mx-2"></div>
          <div className="flex flex-col">
            <span className="font-bold text-foreground text-sm leading-tight">{getDeviceName(currentDeviceId!)}</span>
            <span className="text-[10px] font-mono leading-tight flex items-center gap-1" style={{ color: status === 'connected' ? 'var(--ur-state-success)' : 'var(--ur-state-warning)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: status === 'connected' ? 'var(--ur-state-success)' : 'var(--ur-state-warning)' }}></span>
              {status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : status === 'reconnecting' ? '重连中…' : status === 'frozen' ? '已冻结' : '未连接'}
            </span>
          </div>
          {(status === 'frozen' || status === 'reconnecting' || status === 'disconnected') && (
            <button onClick={handleReconnect} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-opacity hover:opacity-85" style={{ background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' }} title="重新连接">
              <RefreshCw className="w-3.5 h-3.5" />
              重新连接
            </button>
          )}
        </div>

        <div className="flex items-center bg-muted/50 rounded-lg border border-border p-1 gap-1">
          <button onClick={() => setQualityMode('smooth')} className="px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-1.5" style={qualityMode === 'smooth' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
            <Zap className="w-3.5 h-3.5" /> 流畅
          </button>
          <button onClick={() => setQualityMode('balanced')} className="px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-1.5" style={qualityMode === 'balanced' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
            <Activity className="w-3.5 h-3.5" /> 均衡
          </button>
          <button onClick={() => setQualityMode('hd')} className="px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-1.5" style={qualityMode === 'hd' ? { background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' } : { color: 'var(--ur-muted-foreground)' }}>
            <ImageIcon className="w-3.5 h-3.5" /> 高清
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={() => { setFileManagerOpen(true); setFileManagerMinimized(false); }} className="p-1.5 hover:bg-muted rounded text-muted-foreground relative" title="文件管理器">
            <Folder className="w-4 h-4" />
            {fmTransferTasks.filter(t => t.status === "transferring").length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full text-[8px] text-white font-bold flex items-center justify-center" style={{ background: 'var(--ur-primary-500)' }}>
                {fmTransferTasks.filter(t => t.status === "transferring").length}
              </span>
            )}
          </button>

          <div className="flex gap-4 text-xs font-mono text-muted-foreground mr-2">
            <div className="flex flex-col items-end">
              <span className="text-[9px] uppercase">显示</span>
              <span className="font-bold" style={{ color: renderedFps > 20 ? 'var(--ur-state-success)' : 'var(--ur-state-warning)' }}>{renderedFps}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[9px] uppercase">接收</span>
              <span className="font-bold text-primary">{receivedFps}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[9px] uppercase">KB/s</span>
              <span className="font-bold text-primary">{dataRate}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[9px] uppercase">Res</span>
              <span className="text-foreground font-bold">{resolution}</span>
            </div>
          </div>
          <button onClick={() => setShortcutHelpOpen(v => !v)} className="p-2 hover:bg-muted rounded-lg text-foreground transition-colors" title="快捷键">
            <HelpCircle className="w-5 h-5" />
          </button>
          <button onClick={toggleFullscreen} className="p-2 hover:bg-muted rounded-lg text-foreground transition-colors" title="全屏">
            {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
          </button>
        </div>
      </div>

      <div
        onDragOver={handleCanvasDragOver}
        onDragLeave={handleCanvasDragLeave}
        onDrop={handleCanvasDrop}
        className="flex-1 relative flex items-center justify-center overflow-hidden pt-14"
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{
            filter: qualityMode === 'smooth' ? 'contrast(1.05)' : 'none',
            objectFit: 'contain',
          }}
        />

        {/* Keyboard Capture Hint Overlay */}
        {!keyboardCaptured && !fileManagerOpen && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 backdrop-blur-sm cursor-pointer select-none"
            onClick={() => clientRef.current?.captureKeyboard()}
          >
            <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-xl bg-popover/80 border border-border shadow-2xl">
              <Mouse className="w-10 h-10 text-primary" />
              <span className="text-foreground text-base font-bold tracking-wide">点击此处激活键盘控制</span>
              <span className="text-muted-foreground text-xs">点击画布任意位置即可开始操作远程设备</span>
            </div>
          </div>
        )}

        {/* Canvas Drag and Drop Overlay */}
        {isCanvasDragging && (
          <div className="absolute inset-0 z-50 border-4 border-dashed flex flex-col items-center justify-center text-white gap-3" style={{ background: 'rgba(37,99,235,0.2)', backdropFilter: 'blur(8px)', borderColor: 'var(--ur-primary-400)' }}>
            <div className="p-4 rounded-2xl shadow-2xl" style={{ background: 'rgba(37,99,235,0.2)', border: '1px solid rgba(37,99,235,0.3)' }}>
              <UploadCloud className="w-12 h-12 animate-bounce" style={{ color: 'var(--ur-primary-400)' }} />
            </div>
            <h3 className="text-xl font-bold">松开鼠标投送文件到远程设备</h3>
            <p className="text-xs" style={{ color: 'var(--ur-primary-200)' }}>保存路径: <span className="font-mono text-white">{targetDir}</span></p>
          </div>
        )}

        <div className="absolute bottom-6 right-6 flex flex-col gap-2 pointer-events-none z-30 items-end">
          {fileManagerMinimized && (
            <div className="pointer-events-auto bg-popover/95 backdrop-blur border rounded-lg shadow-2xl overflow-hidden cursor-pointer hover:bg-muted transition-colors min-w-[280px]" style={{ borderColor: 'rgba(37,99,235,0.4)' }} onClick={() => setFileManagerMinimized(false)}>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <Folder className="w-4 h-4 text-primary" />
                <span className="text-xs font-bold text-foreground">
                  {fmTransferTasks.length > 0 ? "文件传输中（点击展开）" : "文件管理器（点击展开）"}
                </span>
                {fmTransferTasks.filter(t => t.status === "transferring").length > 0 && (
                  <span className="text-[10px] text-primary ml-auto font-bold">
                    {fmTransferTasks.filter(t => t.status === "transferring").length} 个进行中
                  </span>
                )}
              </div>
              {fmTransferTasks.length > 0 && (
                <div className="px-3 py-2 border-b border-border bg-muted/30">
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-muted-foreground font-medium">总进度</span>
                    <span className="text-primary font-mono font-bold">
                      {totalProgress.percent}% · {totalProgress.doneStr} / {totalProgress.totalStr}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${totalProgress.percent}%`, background: 'var(--ur-primary-500)' }} />
                  </div>
                </div>
              )}
              <div className="max-h-48 overflow-y-auto">
                {fmTransferTasks.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">暂无传输任务</div>
                ) : fmTransferTasks.slice(0, 5).map(task => (
                  <div key={task.id} className="px-3 py-1.5 border-b border-border/50 last:border-b-0">
                    <div className="flex items-center gap-2 text-[11px]">
                      {task.direction === "upload" ? (
                        <UploadCloud className="w-3 h-3 text-primary shrink-0" />
                      ) : (
                        <Download className="w-3 h-3 text-success shrink-0" />
                      )}
                      <span className="text-foreground truncate flex-1">{task.name}</span>
                      <span className="shrink-0 font-mono" style={{ color: task.status === "completed" ? 'var(--ur-state-success)' : task.status === "failed" ? 'var(--ur-state-error)' : 'var(--ur-muted-foreground)' }}>{task.progress}%</span>
                    </div>
                    <div className="w-full h-1 bg-muted rounded-full mt-1 overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${task.progress}%`, background: task.status === "completed" ? 'var(--ur-state-success)' : task.status === "failed" ? 'var(--ur-state-error)' : 'var(--ur-primary-500)' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="bg-popover/80 backdrop-blur border border-border px-3 py-1.5 rounded text-[10px] text-foreground font-bold flex items-center gap-2">
            {keyboardCaptured ? <span className="text-success">已捕获键盘</span> : <span className="text-muted-foreground">未捕获键盘</span>}
          </div>
        </div>
      </div>

      {/* Shortcut Help Overlay */}
      {shortcutHelpOpen && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShortcutHelpOpen(false)}>
          <div className="bg-card border border-border rounded-lg p-5 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-foreground">远程控制快捷键</h3>
              <button onClick={() => setShortcutHelpOpen(false)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors" title="关闭">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5">
              {[
                { key: "点击画面", desc: "激活键盘控制（之后键盘输入直达远程）" },
                { key: "Ctrl + Alt + Del", desc: "发送系统按键（任务管理器等）" },
                { key: "流畅 / 均衡 / 高清", desc: "切换画质档位" },
                { key: "全屏按钮 / Esc", desc: "进入 / 退出全屏" },
                { key: "?", desc: "打开 / 关闭本帮助" },
              ].map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4">
                  <span className="font-mono text-xs text-primary font-bold whitespace-nowrap">{row.key}</span>
                  <span className="text-xs text-muted-foreground text-right">{row.desc}</span>
                </div>
              ))}
            </div>
            <button onClick={() => setShortcutHelpOpen(false)} className="mt-5 w-full py-2 rounded-md text-sm font-bold transition-opacity hover:opacity-85" style={{ background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' }}>知道了</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app-shell bg-background text-foreground font-sans select-none">
      {/* Modal */}
      {modalOpen && (() => {
        const device = editingDeviceId ? devices.find(d => d.id === editingDeviceId) : null;
        return (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="bg-popover border border-border rounded-lg shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
              {/* Header */}
              <div className="px-6 py-4 border-b border-border flex justify-between items-center gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Monitor className="w-4 h-4 text-primary flex-shrink-0" />
                  <h3 className="text-sm font-semibold text-foreground truncate">设备详情</h3>
                  {device && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${device.online ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'}`}>
                      {device.online ? '在线' : '离线'}
                    </span>
                  )}
                </div>
                <button onClick={() => { setModalOpen(false); setThumbnailUrl(null); }} className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Body - 参照 doubao_html 布局：三区 grid 行，分行合入识别与命名 */}
              <div className="p-6 flex flex-col gap-6 overflow-y-auto max-h-[70vh]">
                {/* ─── 识别与命名（含设备分组） ─── */}
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-[3px] h-4 rounded-full flex-shrink-0" style={{ background: 'var(--ur-primary-500)' }} />
                    <span className="text-xs font-medium text-muted-foreground">识别与命名</span>
                  </div>
                  <div className="grid grid-cols-[130px_1fr] items-center gap-x-4 gap-y-3.5">
                    {/* 系统 ID + 复制 */}
                    <span className="text-xs text-muted-foreground flex-shrink-0">系统 ID</span>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-foreground font-mono truncate">{editingDeviceId}</span>
                      <button onClick={() => handleCopy(editingDeviceId || '', 'id')} className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0" title="复制系统 ID">
                        {copiedField === 'id' ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                    {/* 自定义名称 */}
                    <span className="text-xs text-muted-foreground flex-shrink-0">自定义名称</span>
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                      placeholder="例如：大厅主屏幕"
                    />
                    {/* 设备分组 */}
                    <span className="text-xs text-muted-foreground flex-shrink-0">设备分组</span>
                    {allGroups.length === 0 ? (
                      <span className="text-xs text-muted-foreground">暂无分组</span>
                    ) : (
                      <select
                        value={editingTags.split(",").map(t => t.trim()).filter(Boolean)[0] || ""}
                        onChange={(e) => setEditingTags(e.target.value)}
                        className="bg-background border border-border rounded px-2.5 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:border-primary w-full"
                      >
                        <option value="">(无分组)</option>
                        {allGroups.map(group => (
                          <option key={group.name} value={group.name}>{group.name} ({group.count})</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* ─── 网络信息 ─── */}
                {device && (
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-[3px] h-4 rounded-full flex-shrink-0" style={{ background: 'var(--ur-state-success)' }} />
                      <span className="text-xs font-medium text-muted-foreground">网络信息</span>
                    </div>
                    <div className="grid grid-cols-[130px_1fr] items-center gap-x-4 gap-y-3.5">
                      {/* IP */}
                      <span className="text-xs text-muted-foreground flex-shrink-0">IP 地址</span>
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="text-xs text-foreground font-mono truncate cursor-pointer hover:text-primary transition-colors"
                          onClick={() => handleCopy(device.ip ? device.ip.split(':')[0] : '', 'ip')}
                        >{device.ip ? device.ip.split(':')[0] : 'Unknown'}</span>
                        <button onClick={() => handleCopy(device.ip ? device.ip.split(':')[0] : '', 'ip')} className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0" title="复制 IP">
                          {copiedField === 'ip' ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      {/* MAC */}
                      <span className="text-xs text-muted-foreground flex-shrink-0">MAC 地址</span>
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="text-xs text-foreground font-mono truncate cursor-pointer hover:text-primary transition-colors"
                          onClick={() => handleCopy(formatMac(device.mac), 'mac')}
                        >{formatMac(device.mac)}</span>
                        <button onClick={() => handleCopy(formatMac(device.mac), 'mac')} className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0" title="复制 MAC">
                          {copiedField === 'mac' ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ─── 系统信息 ─── */}
                {device && (
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-[3px] h-4 rounded-full flex-shrink-0" style={{ background: 'var(--ur-muted-foreground)' }} />
                      <span className="text-xs font-medium text-muted-foreground">系统信息</span>
                    </div>
                    <div className="grid grid-cols-[130px_1fr] items-center gap-x-4 gap-y-3.5">
                      {/* OS */}
                      <span className="text-xs text-muted-foreground flex-shrink-0">操作系统</span>
                      <span className="text-xs text-foreground">{device.os || 'Unknown'}</span>
                      {/* CPU */}
                      <span className="text-xs text-muted-foreground flex-shrink-0">CPU</span>
                      <span className="text-xs text-foreground truncate" title={device.cpu}>{device.cpu || 'Unknown'}</span>
                      {/* RAM */}
                      <span className="text-xs text-muted-foreground flex-shrink-0">内存</span>
                      <span className="text-xs text-foreground">{device.ram ? `${device.ram} GB` : 'Unknown'}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-3">
                <button onClick={() => { setModalOpen(false); setThumbnailUrl(null); }} className="px-4 py-2 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">取消</button>
                <button
                  onClick={saveDeviceDetails}
                  disabled={
                    editingName === (devices.find(d => d.id === editingDeviceId)?.name ?? "") &&
                    editingTags === (devices.find(d => d.id === editingDeviceId)?.tags?.[0] ?? "")
                  }
                  className="px-5 py-2 rounded text-xs font-medium transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--ur-primary-600)', color: 'var(--ur-primary-50)' }}
                >保存更改</button>
            </div>
          </div>
        </div>
      );
      })()}

      {/* Sidebar (hidden when remote) */}
      {currentView !== 'remote' && renderSidebar()}

      {/* Main content */}
      {currentView === 'remote' ? (
        renderRemoteView()
      ) : (
        <div className="app-main-col">
          {renderHeader()}
          {currentView === 'devices' && renderDevicesView()}
          {currentView === 'device-info' && renderDeviceInfoView()}
          {currentView === 'file-transfer' && renderFileTransferView()}
          {currentView === 'settings' && renderSettingsView()}
        </div>
      )}

      <FileManager
        isOpen={fileManagerOpen && !fileManagerMinimized}
        onClose={() => { setFileManagerOpen(false); setFileManagerMinimized(false); setFmTransferTasks([]); }}
        onMinimize={() => setFileManagerMinimized(true)}
        tasks={fmTransferTasks}
        setTasks={setFmTransferTasks}
        clientRef={clientRef}
        deviceName={currentDeviceId ? getDeviceName(currentDeviceId) : ""}
      />

      {terminalDevice && (
        <TerminalModal
          serverUrl={serverUrl}
          deviceId={terminalDevice.id}
          deviceName={terminalDevice.name}
          onClose={() => setTerminalDevice(null)}
        />
      )}

      {configPanelDevice && (
        <SystemConfigPanel
          device={configPanelDevice}
          serverUrl={serverUrl}
          onClose={() => setConfigPanelDevice(null)}
        />
      )}

      <Toaster />
      <DialogHost />
    </div>
  );
}
