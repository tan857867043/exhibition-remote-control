import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ExhibitionRemoteClient from "./lib/ExhibitionRemoteClient.js";
import { Monitor, WifiOff, Settings, Mouse, Cast, Lock, Terminal, Router, X, Maximize, Minimize, ChevronLeft, Zap, Image as ImageIcon, Activity, Folder, UploadCloud, Download, Copy, Check, Search, Power, RefreshCw } from "lucide-react";
import { traverseFileTree } from "./lib/fileSystem";
import { FileManager, TransferTaskItem } from "./components/FileManager";

interface DeviceInfo {
  id: string;
  name: string;
  os: string;
  ip: string;
  cpu: string;
  ram: string;
  mac: string;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState("http://localhost:38921");
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [knownDevices, setKnownDevices] = useState<DeviceInfo[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('exhibition_known_devices') || '[]');
    } catch (e) {
      return [];
    }
  });
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState<"disconnected" | "loading" | "connected">("disconnected");
  const [viewMode, setViewMode] = useState<"devices" | "remote">("devices");

  
  const [renderedFps, setRenderedFps] = useState(0);
  const [receivedFps, setReceivedFps] = useState(0);
  const [dataRate, setDataRate] = useState(0);
  const [blockCount, setBlockCount] = useState(0);
  const [resolution, setResolution] = useState("--");
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [qualityMode, setQualityMode] = useState<"smooth" | "balanced" | "hd">("balanced");
  
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('exhibition_device_names') || '{}');
    } catch (e) {
      return {};
    }
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [targetDir, setTargetDir] = useState("C:\\Users\\Public\\Downloads");
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [fileManagerMinimized, setFileManagerMinimized] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [fmTransferTasks, setFmTransferTasks] = useState<TransferTaskItem[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const filteredDevices = useMemo(() => {
    let list = knownDevices;
    if (searchQuery.trim()) {
      list = knownDevices.filter(d => {
        const dName = deviceNames[d.id] || d.name || "未命名设备";
        return dName.toLowerCase().includes(searchQuery.toLowerCase()) || 
               d.os.toLowerCase().includes(searchQuery.toLowerCase()) ||
               d.ip.toLowerCase().includes(searchQuery.toLowerCase());
      });
    }
    
    // Sort online devices first
    const onlineIds = new Set(devices.map(d => d.id));
    return list.sort((a, b) => {
      const aOnline = onlineIds.has(a.id);
      const bOnline = onlineIds.has(b.id);
      if (aOnline && !bOnline) return -1;
      if (!aOnline && bOnline) return 1;
      return 0;
    });
  }, [knownDevices, devices, searchQuery, deviceNames]);

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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<any>(null);

  const handleSendFiles = async (files: FileList | File[], dir: string, overwriteMode: string, applyToAll: boolean, directories?: string[]) => {
    if (!clientRef.current) {
      alert("请先连接到远程设备");
      return;
    }
    const fileArray = Array.from(files);

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
      const relPath = (file as any)._relativePath;
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

  const getDeviceName = (id: string) => {
    const custom = deviceNames[id];
    if (custom) return custom;
    const info = devices.find(d => d.id === id);
    return info?.name || id;
  };

  const removeKnownDevice = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要从列表中移除该离线设备吗？")) return;
    setKnownDevices(prev => {
      const updated = prev.filter(d => d.id !== id);
      localStorage.setItem('exhibition_known_devices', JSON.stringify(updated));
      return updated;
    });
  };

  const loadDevices = async () => {
    if (viewMode === 'remote') return;
    setStatus("loading");
    try {
      const res = await fetch(`${serverUrl}/api/v1/devices`);
      const data = await res.json();
      setDevices(data);
      
      setKnownDevices(prev => {
        const map = new Map(prev.map(d => [d.id, d]));
        data.forEach((d: DeviceInfo) => map.set(d.id, d));
        const updated = Array.from(map.values());
        localStorage.setItem('exhibition_known_devices', JSON.stringify(updated));
        return updated;
      });

      setStatus("disconnected");
    } catch (e) {
      console.error(e);
      setStatus("disconnected");
      setDevices([]);
    }
  };

  const handleDownloadAgent = async () => {
    try {
      const res = await fetch(`${serverUrl}/agents`);
      if (!res.ok) throw new Error('下载失败');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'exhibition-agent.exe';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error(e);
      alert('Agent 下载失败，请确认服务端已编译 Agent');
    }
  };

  useEffect(() => {
    loadDevices();
    const interval = setInterval(() => {
      if (viewMode === 'devices') loadDevices();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, serverUrl]);

  const connectDevice = (deviceId: string) => {
    if (!deviceId) return;

    if (clientRef.current) {
      if (clientRef.current.ws) clientRef.current.ws.close();
      clientRef.current.releaseKeyboard();
    }

    setCurrentDeviceId(deviceId);
    setViewMode("remote");
    setStatus("connecting");
    
    // We need to wait for the view to render the canvas before initializing the client
    setTimeout(() => {
      if (canvasRef.current) {
        clientRef.current = new ExhibitionRemoteClient(canvasRef.current, serverUrl, deviceId, (stats: any) => {
          if (stats.type === 'frame') {
            bytesReceivedRef.current += stats.byteLength || 0;
            if (stats.frameType === 0x01) blockCounterRef.current++;
          } else if (stats.type === 'keyboard') {
            setKeyboardCaptured(stats.captured);
          }
        });
        // Override ws.onclose to mark transferring tasks as failed on disconnect
        if (clientRef.current.ws) {
          const origOnClose = clientRef.current.ws.onclose;
          clientRef.current.ws.onclose = (e: CloseEvent) => {
            if (origOnClose) origOnClose.call(clientRef.current.ws, e);
            setFmTransferTasks((prev) =>
              prev.map((t) =>
                t.status === "transferring"
                  ? { ...t, status: "failed", error: "网络中断" }
                  : t
              )
            );
          };
        }
        setStatus("connected");
      }
    }, 100);

    bytesReceivedRef.current = 0;
    blockCounterRef.current = 0;
    setRenderedFps(0);
    setReceivedFps(0);
  };

  const disconnectDevice = () => {
    if (clientRef.current) {
      clientRef.current.releaseKeyboard();
      if (clientRef.current.ws) clientRef.current.ws.close();
    }
    clientRef.current = null;
    setStatus("disconnected");
    setCurrentDeviceId(null);
    setRenderedFps(0);
    setReceivedFps(0);
    setDataRate(0);
    setBlockCount(0);
    setResolution("--");
    setKeyboardCaptured(false);
    setViewMode("devices");
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.log(err));
    }
  };

  useEffect(() => {
    if (viewMode !== 'remote') return;

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
    };
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'remote' || !clientRef.current) return;
    let v = 50;
    if (qualityMode === 'smooth') v = 30;
    else if (qualityMode === 'hd') v = 75;
    clientRef.current.setQuality(v);
  }, [qualityMode, viewMode]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

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

  const openDeviceDetails = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingDeviceId(id);
    setEditingName(deviceNames[id] || "");
    setModalOpen(true);
  };

  const saveDeviceDetails = () => {
    if (!editingDeviceId) return;
    const newNames = { ...deviceNames };
    const trimmed = editingName.trim();
    if (trimmed) {
      newNames[editingDeviceId] = trimmed;
    } else {
      delete newNames[editingDeviceId];
    }
    setDeviceNames(newNames);
    localStorage.setItem('exhibition_device_names', JSON.stringify(newNames));
    setModalOpen(false);
  };

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden bg-slate-950 text-slate-200 font-sans select-none">
      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Terminal className="w-5 h-5 text-indigo-500" />
                设备详情
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">系统设备 ID (不可更改)</label>
                <div className="bg-slate-950 border border-slate-800 px-3 py-2 rounded text-slate-400 font-mono text-sm select-all">
                  <span>{editingDeviceId}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">自定义显示名称</label>
                <input 
                  type="text" 
                  value={editingName} 
                  onChange={(e) => setEditingName(e.target.value)} 
                  className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50 text-slate-200 placeholder-slate-600" 
                  placeholder="例如：大厅主屏幕" 
                />
              </div>

              {editingDeviceId && devices.find(d => d.id === editingDeviceId) && (() => {
                const device = devices.find(d => d.id === editingDeviceId)!;
                return (
                  <div className="flex flex-col gap-3 pt-2">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800 pb-1">硬件与网络信息</label>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="flex flex-col gap-1">
                        <span className="text-slate-500 font-mono">操作系统</span>
                        <span className="text-slate-300">{device.os || 'Unknown'}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-slate-500 font-mono">IP 地址</span>
                        <div className="flex items-center justify-between bg-slate-950 px-2 py-1.5 rounded border border-slate-800 group relative">
                          <span className="text-slate-300 font-mono truncate">{device.ip ? device.ip.split(':')[0] : 'Unknown'}</span>
                          {device.ip && (
                            <button 
                              onClick={() => handleCopy(device.ip.split(':')[0], 'ip')} 
                              className="text-slate-500 hover:text-indigo-400 transition-colors"
                              title="复制 IP 地址"
                            >
                              {copiedField === 'ip' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-slate-500 font-mono">CPU 信息</span>
                        <span className="text-slate-300 truncate" title={device.cpu}>{device.cpu || 'Unknown'}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-slate-500 font-mono">内存容量</span>
                        <span className="text-slate-300">{device.ram ? `${device.ram} GB` : 'Unknown'}</span>
                      </div>
                      <div className="flex flex-col gap-1 col-span-2">
                        <span className="text-slate-500 font-mono">MAC 地址</span>
                        <div className="flex items-center justify-between bg-slate-950 px-2 py-1.5 rounded border border-slate-800 group relative">
                          <span className="text-slate-300 font-mono truncate">{device.mac ? device.mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase().match(/.{1,2}/g)?.join(':') || 'Unknown' : 'Unknown'}</span>
                          {device.mac && (
                            <button 
                              onClick={() => handleCopy(device.mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase().match(/.{1,2}/g)?.join(':') || '', 'mac')} 
                              className="text-slate-500 hover:text-indigo-400 transition-colors"
                              title="复制 MAC 地址"
                            >
                              {copiedField === 'mac' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/50 flex justify-end gap-3">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors">取消</button>
              <button onClick={saveDeviceDetails} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold uppercase tracking-wider transition-colors shadow-[0_0_12px_rgba(99,102,241,0.3)]">保存更改</button>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'devices' ? (
        <div className="flex flex-col h-full">
          {/* Header */}
          <header className="h-16 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 shrink-0">
            <div className="flex items-center gap-6">
              <span className="font-bold tracking-tight text-slate-100 flex items-center gap-3 text-lg">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.5)]">
                  <Monitor className="w-5 h-5 text-white" />
                </div>
                Ultra Remote
              </span>
              
              <div className="h-6 w-px bg-slate-800 hidden md:block"></div>
              
              <div className="hidden md:flex relative items-center">
                <Search className="w-4 h-4 text-slate-500 absolute left-3" />
                <input 
                  type="text" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索设备名称、IP 或系统..."
                  className="bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-4 py-1.5 text-sm focus:outline-none focus:border-indigo-500/50 text-slate-300 w-[240px] transition-all shadow-inner"
                />
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="flex items-center bg-slate-950 rounded border border-slate-800 focus-within:border-indigo-500/50 transition-colors">
                <input 
                  type="text" 
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  className="bg-transparent border-none outline-none text-xs text-slate-300 font-mono px-3 py-1.5 w-[200px]"
                  placeholder="WebSocket Server URL"
                />
              </div>
              <button onClick={loadDevices} title="刷新设备列表" className="p-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-300 transition-all flex items-center">
                <RefreshCw className="w-4 h-4" />
              </button>
              <button onClick={handleDownloadAgent} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 border border-indigo-500/50 rounded-lg text-xs font-bold transition-all text-white shadow-[0_0_12px_rgba(99,102,241,0.25)] flex items-center gap-2">
                <Download className="w-3.5 h-3.5" /> Agent
              </button>
            </div>
          </header>

          {/* Devices Grid */}
          <main className="flex-1 overflow-y-auto p-8 bg-slate-950">
            <div className="max-w-[1400px] mx-auto">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                  <span className="w-2 h-6 bg-indigo-500 rounded-full inline-block"></span>
                  我的设备
                  <span className="ml-2 text-sm font-normal text-slate-500 bg-slate-900 px-2.5 py-0.5 rounded-full border border-slate-800">
                    {filteredDevices.length} 台在线
                  </span>
                </h2>
              </div>

              {devices.length === 0 ? (
                <div className="mt-20 flex flex-col items-center justify-center text-slate-500 gap-4">
                  <div className="w-24 h-24 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center">
                    <WifiOff className="w-10 h-10 opacity-40" />
                  </div>
                  <p className="text-lg font-medium text-slate-400">暂无在线设备</p>
                  <p className="text-sm">请在被控端启动 Agent 程序</p>
                </div>
              ) : filteredDevices.length === 0 ? (
                <div className="mt-20 flex flex-col items-center justify-center text-slate-500 gap-4">
                  <div className="w-24 h-24 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center">
                    <Search className="w-10 h-10 opacity-40" />
                  </div>
                  <p className="text-lg font-medium text-slate-400">未找到匹配的设备</p>
                  <p className="text-sm">请尝试其他搜索词</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
                  {filteredDevices.map(device => {
                    const id = device.id;
                    const displayName = getDeviceName(id);
                    
                    const osLower = (device.os || "").toLowerCase();
                    const isWindows = osLower.includes('windows');
                    const isMac = osLower.includes('darwin') || osLower.includes('mac');
                    const isLinux = osLower.includes('linux');
                    const isOnline = devices.some(d => d.id === id);

                    return (
                      <div 
                        key={id} 
                        className={`bg-slate-900 border border-slate-800 rounded-xl p-3 transition-all group flex flex-col gap-3 relative ${isOnline ? 'hover:border-indigo-500/50 hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] cursor-pointer' : 'opacity-60 cursor-default grayscale-[0.5]'}`}
                        onClick={() => isOnline && connectDevice(id)}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-2.5">
                            <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center shrink-0 shadow-inner">
                              {isWindows ? (
                                <Monitor className="w-4 h-4 text-blue-400" />
                              ) : isMac ? (
                                <Monitor className="w-4 h-4 text-slate-300" />
                              ) : isLinux ? (
                                <Terminal className="w-4 h-4 text-yellow-400" />
                              ) : (
                                <Monitor className="w-4 h-4 text-indigo-400" />
                              )}
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="font-bold text-slate-100 text-sm truncate w-full" title={displayName}>{displayName}</span>
                              {isOnline ? (
                                <span className="text-[10px] text-emerald-400 flex items-center gap-1.5 mt-0.5">
                                  <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                  </span>
                                  在线可用
                                </span>
                              ) : (
                                <span className="text-[10px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                                  <span className="relative flex h-2 w-2">
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-slate-600"></span>
                                  </span>
                                  设备离线
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            {!isOnline && (
                               <button onClick={(e) => removeKnownDevice(id, e)} className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-800 transition-colors" title="移除设备">
                                 <X className="w-3.5 h-3.5" />
                               </button>
                            )}
                            {isOnline && (
                              <button onClick={(e) => { e.stopPropagation(); }} className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-800 transition-colors" title="重启/关机 (示例)">
                                <Power className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={(e) => openDeviceDetails(id, e)} className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors" title="设备详情">
                              <Settings className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        
                        <div className="relative w-full aspect-video bg-black rounded-lg border border-slate-800 overflow-hidden flex items-center justify-center group/screen">
                          {isOnline ? (
                            <>
                              <img 
                                src={`${serverUrl}/api/v1/devices/thumbnail?device_id=${id}&t=${Date.now()}`} 
                                alt="Screen Thumbnail"
                                className="w-full h-full object-cover opacity-60 group-hover/screen:opacity-100 transition-opacity"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                  (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="text-slate-700 flex flex-col items-center"><svg class="w-6 h-6 mb-1" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg><span class="text-[10px]">无缩略图</span></div>';
                                }}
                              />
                              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/screen:opacity-100 bg-indigo-900/40 backdrop-blur-[2px] transition-all">
                                <div className="bg-indigo-600 text-white rounded-full p-2.5 shadow-xl transform scale-75 group-hover/screen:scale-100 transition-transform">
                                  <Cast className="w-5 h-5" />
                                </div>
                              </div>
                            </>
                          ) : (
                            <div className="text-slate-700 flex flex-col items-center">
                              <WifiOff className="w-6 h-6 mb-1" />
                              <span className="text-[10px]">设备离线</span>
                            </div>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <button 
                            disabled={!isOnline}
                            onClick={(e) => {
                              e.stopPropagation();
                              connectDevice(id);
                              setFileManagerOpen(true);
                              setFileManagerMinimized(false);
                            }}
                            className={`flex-1 bg-slate-950 rounded-lg py-1.5 border border-slate-800 text-xs flex items-center justify-center gap-1.5 transition-colors
                              ${isOnline ? 'hover:bg-indigo-600/20 hover:border-indigo-500/30 text-slate-300 hover:text-indigo-300' : 'text-slate-600 cursor-not-allowed opacity-50'}`}
                          >
                            <Folder className="w-3.5 h-3.5" />
                            传文件
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </main>
        </div>
      ) : (
        /* Remote Control View */
        <div ref={containerRef} className="flex flex-col h-full bg-black relative">
          
          {/* Top Floating Toolbar (auto-hide can be added later) */}
          <div className="absolute top-0 left-0 right-0 h-14 bg-slate-900/90 backdrop-blur-md border-b border-slate-700/50 z-40 flex items-center justify-between px-4 opacity-0 hover:opacity-100 transition-opacity duration-300 pointer-events-none" style={{ opacity: isFullscreen ? undefined : 1 }}>
            <div className="flex items-center gap-4 pointer-events-auto">
              <button 
                onClick={disconnectDevice}
                className="p-2 hover:bg-slate-800 rounded-lg text-slate-300 hover:text-white transition-colors flex items-center gap-2"
              >
                <ChevronLeft className="w-5 h-5" />
                <span className="font-bold text-sm">返回</span>
              </button>
              
              <div className="h-6 w-px bg-slate-700 mx-2"></div>
              
              <div className="flex flex-col">
                <span className="font-bold text-slate-100 text-sm leading-tight">{getDeviceName(currentDeviceId!)}</span>
                <span className="text-[10px] text-emerald-400 font-mono leading-tight flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> 已连接
                </span>
              </div>
            </div>

            <div className="flex items-center bg-slate-950/50 rounded-lg border border-slate-800 p-1 gap-1 pointer-events-auto">
              <button 
                onClick={() => setQualityMode('smooth')}
                className={`px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-1.5 ${qualityMode === 'smooth' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <Zap className="w-3.5 h-3.5" /> 流畅
              </button>
              <button 
                onClick={() => setQualityMode('balanced')}
                className={`px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-1.5 ${qualityMode === 'balanced' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <Activity className="w-3.5 h-3.5" /> 均衡
              </button>
              <button 
                onClick={() => setQualityMode('hd')}
                className={`px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-1.5 ${qualityMode === 'hd' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <ImageIcon className="w-3.5 h-3.5" /> 高清
              </button>
            </div>

            <div className="flex items-center gap-3 pointer-events-auto">

              <button 
                onClick={() => { setFileManagerOpen(true); setFileManagerMinimized(false); }}
                className="p-1.5 hover:bg-slate-700/50 rounded text-slate-400 relative"
                title="文件管理器"
              >
                <Folder className="w-4 h-4" />
                {fmTransferTasks.filter(t => t.status === "transferring").length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-indigo-500 rounded-full text-[8px] text-white font-bold flex items-center justify-center">
                    {fmTransferTasks.filter(t => t.status === "transferring").length}
                  </span>
                )}
              </button>

              <div className="flex gap-4 text-xs font-mono text-slate-400 mr-2">
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase">显示</span>
                  <span className={renderedFps > 20 ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>{renderedFps}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase">接收</span>
                  <span className="text-blue-400 font-bold">{receivedFps}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase">KB/s</span>
                  <span className="text-cyan-400 font-bold">{dataRate}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase">Res</span>
                  <span className="text-slate-300 font-bold">{resolution}</span>
                </div>
              </div>
              <button 
                onClick={toggleFullscreen}
                className="p-2 hover:bg-slate-800 rounded-lg text-slate-300 hover:text-white transition-colors"
                title="全屏"
              >
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
            {status === "connected" && !keyboardCaptured && (
              <div 
                className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm cursor-pointer select-none"
                onClick={() => clientRef.current?.captureKeyboard()}
              >
                <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-xl bg-slate-900/80 border border-slate-700/50 shadow-2xl">
                  <span className="text-4xl">🖱️</span>
                  <span className="text-white text-base font-bold tracking-wide">点击此处激活键盘控制</span>
                  <span className="text-slate-400 text-xs">点击画布任意位置即可开始操作远程设备</span>
                </div>
              </div>
            )}

            {/* Canvas Drag and Drop Overlay */}
            {isCanvasDragging && (
              <div className="absolute inset-0 z-50 bg-blue-950/80 backdrop-blur-md border-4 border-dashed border-blue-400 flex flex-col items-center justify-center text-white gap-3 animate-in fade-in duration-150">
                <div className="p-4 bg-blue-500/20 border border-blue-400/30 rounded-2xl shadow-2xl">
                  <UploadCloud className="w-12 h-12 text-blue-400 animate-bounce" />
                </div>
                <h3 className="text-xl font-bold">松开鼠标投送文件到远程设备</h3>
                <p className="text-xs text-blue-200">保存路径: <span className="font-mono text-white">{targetDir}</span></p>
              </div>
            )}
            
            <div className="absolute bottom-6 right-6 flex flex-col gap-2 pointer-events-none z-30 items-end">
              {fileManagerMinimized && (
                <div className="pointer-events-auto bg-slate-900/95 backdrop-blur border border-indigo-500/40 rounded-lg shadow-2xl overflow-hidden cursor-pointer hover:bg-slate-800 transition-colors min-w-[280px]"
                  onClick={() => setFileManagerMinimized(false)}>
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700">
                    <Folder className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-bold text-slate-200">
                      {fmTransferTasks.length > 0 ? "文件传输中（点击展开）" : "文件管理器（点击展开）"}
                    </span>
                    {fmTransferTasks.filter(t => t.status === "transferring").length > 0 && (
                      <span className="text-[10px] text-indigo-400 ml-auto font-bold">
                        {fmTransferTasks.filter(t => t.status === "transferring").length} 个进行中
                      </span>
                    )}
                  </div>
                  {fmTransferTasks.length > 0 && (
                    <div className="px-3 py-2 border-b border-slate-700 bg-slate-800/30">
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-slate-400 font-medium">总进度</span>
                        <span className="text-indigo-400 font-mono font-bold">
                          {totalProgress.percent}% · {totalProgress.doneStr} / {totalProgress.totalStr}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all"
                          style={{ width: `${totalProgress.percent}%` }} />
                      </div>
                    </div>
                  )}
                  <div className="max-h-48 overflow-y-auto">
                    {fmTransferTasks.length === 0 ? (
                      <div className="px-3 py-4 text-center text-[11px] text-slate-500">暂无传输任务</div>
                    ) : fmTransferTasks.slice(0, 5).map(task => (
                      <div key={task.id} className="px-3 py-1.5 border-b border-slate-800/50 last:border-b-0">
                        <div className="flex items-center gap-2 text-[11px]">
                          {task.direction === "upload" ? (
                            <UploadCloud className="w-3 h-3 text-blue-400 shrink-0" />
                          ) : (
                            <Download className="w-3 h-3 text-emerald-400 shrink-0" />
                          )}
                          <span className="text-slate-300 truncate flex-1">{task.name}</span>
                          <span className={`shrink-0 font-mono ${
                            task.status === "completed" ? "text-emerald-400" :
                            task.status === "failed" ? "text-red-400" :
                            "text-slate-400"
                          }`}>{task.progress}%</span>
                        </div>
                        <div className="w-full h-1 bg-slate-700 rounded-full mt-1 overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${
                            task.status === "completed" ? "bg-emerald-500" :
                            task.status === "failed" ? "bg-red-500" :
                            "bg-indigo-500"
                          }`} style={{ width: `${task.progress}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="bg-slate-900/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded text-[10px] text-slate-300 font-bold flex items-center gap-2">
                {keyboardCaptured ? <span className="text-emerald-400">⌨️ 已捕获</span> : "⌨️ 未捕获"}
              </div>
            </div>
          </div>
        </div>
      )}

      <FileManager isOpen={fileManagerOpen && status === "connected" && !fileManagerMinimized}
        onClose={() => { setFileManagerOpen(false); setFileManagerMinimized(false); setFmTransferTasks([]); }}
        onMinimize={() => setFileManagerMinimized(true)}
        tasks={fmTransferTasks}
        setTasks={setFmTransferTasks}
        clientRef={clientRef} deviceName={currentDeviceId ? getDeviceName(currentDeviceId) : ""} />
    </div>
  );
}
