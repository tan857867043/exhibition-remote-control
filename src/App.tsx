import React, { useState, useEffect, useRef, useCallback } from "react";
import ExhibitionRemoteClient from "./lib/ExhibitionRemoteClient.js";
import { Monitor, WifiOff, Settings, Mouse, Cast, Lock, Terminal, Router, X, Maximize, Minimize, ChevronLeft, Zap, Image as ImageIcon, Activity } from "lucide-react";

interface DeviceInfo {
  id: string;
  name: string;
  os: string;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8080");
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState<"disconnected" | "loading" | "connected">("disconnected");
  const [viewMode, setViewMode] = useState<"devices" | "remote">("devices");
  
  const [fps, setFps] = useState(0);
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<any>(null);
  
  const fpsCounterRef = useRef(0);
  const bytesReceivedRef = useRef(0);
  const blockCounterRef = useRef(0);

  const getDeviceName = (id: string) => {
    const custom = deviceNames[id];
    if (custom) return custom;
    const info = devices.find(d => d.id === id);
    return info?.name || id;
  };

  const loadDevices = async () => {
    if (viewMode === 'remote') return;
    setStatus("loading");
    try {
      const res = await fetch(`${serverUrl}/api/v1/devices`);
      const data = await res.json();
      setDevices(data);
      setStatus("disconnected");
    } catch (e) {
      console.error(e);
      setStatus("disconnected");
      setDevices([]);
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
    
    // We need to wait for the view to render the canvas before initializing the client
    setTimeout(() => {
      if (canvasRef.current) {
        clientRef.current = new ExhibitionRemoteClient(canvasRef.current, serverUrl, deviceId, (stats: any) => {
          if (stats.type === 'frame') {
            fpsCounterRef.current++;
            bytesReceivedRef.current += stats.byteLength || 0;
            if (stats.frameType === 0x01) blockCounterRef.current++;
          } else if (stats.type === 'keyboard') {
            setKeyboardCaptured(stats.captured);
          }
        });
      }
    }, 100);

    fpsCounterRef.current = 0;
    bytesReceivedRef.current = 0;
    blockCounterRef.current = 0;
    setStatus("connected");
  };

  const disconnectDevice = () => {
    if (clientRef.current) {
      clientRef.current.releaseKeyboard();
      if (clientRef.current.ws) clientRef.current.ws.close();
    }
    clientRef.current = null;
    setStatus("disconnected");
    setCurrentDeviceId(null);
    setFps(0);
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
      setFps(fpsCounterRef.current);
      fpsCounterRef.current = 0;
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
            <div className="flex items-center gap-4">
              <span className="font-bold tracking-tight text-slate-100 flex items-center gap-3 text-lg">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.5)]">
                  <Monitor className="w-5 h-5 text-white" />
                </div>
                Ultra Remote
              </span>
            </div>
            <div className="flex items-center gap-4">
              <input 
                type="text" 
                value={serverUrl} 
                onChange={e => setServerUrl(e.target.value)} 
                className="bg-slate-950 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500/50 text-slate-300 w-64 font-mono shadow-inner" 
                placeholder="服务端地址" 
              />
              <button onClick={loadDevices} className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 text-sm font-bold transition-all text-slate-200 shadow-sm flex items-center gap-2">
                <Router className="w-4 h-4" /> 刷新
              </button>
            </div>
          </header>

          {/* Devices Grid */}
          <main className="flex-1 overflow-y-auto p-8 bg-slate-950">
            <div className="max-w-6xl mx-auto">
              <h2 className="text-xl font-bold text-slate-100 mb-6 flex items-center gap-2">
                <span className="w-2 h-6 bg-indigo-500 rounded-full inline-block"></span>
                我的设备
                <span className="ml-2 text-sm font-normal text-slate-500 bg-slate-900 px-2.5 py-0.5 rounded-full border border-slate-800">
                  {devices.length} 台在线
                </span>
              </h2>

              {devices.length === 0 ? (
                <div className="mt-20 flex flex-col items-center justify-center text-slate-500 gap-4">
                  <div className="w-24 h-24 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center">
                    <WifiOff className="w-10 h-10 opacity-40" />
                  </div>
                  <p className="text-lg font-medium text-slate-400">暂无在线设备</p>
                  <p className="text-sm">请在被控端启动 Agent 程序</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {devices.map(device => {
                    const id = device.id;
                    const displayName = getDeviceName(id);
                    return (
                      <div 
                        key={id} 
                        className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-indigo-500/50 hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] transition-all group flex flex-col gap-4 cursor-pointer overflow-hidden"
                        onClick={() => connectDevice(id)}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-full bg-indigo-500/10 flex items-center justify-center shrink-0">
                              <Monitor className="w-6 h-6 text-indigo-400" />
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="font-bold text-slate-100 text-lg truncate w-full" title={displayName}>{displayName}</span>
                              <span className="text-xs text-emerald-400 flex items-center gap-1 mt-0.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> 在线可用
                              </span>
                            </div>
                          </div>
                          <button onClick={(e) => openDeviceDetails(id, e)} className="text-slate-500 hover:text-white p-2 rounded-lg hover:bg-slate-800 transition-colors shrink-0">
                            <Settings className="w-5 h-5" />
                          </button>
                        </div>
                        
                        <div className="relative w-full aspect-video bg-black rounded-lg border border-slate-800 overflow-hidden flex items-center justify-center">
                          <img 
                            src={`${serverUrl}/api/v1/devices/thumbnail?device_id=${id}&t=${Date.now()}`} 
                            alt="Screen Thumbnail"
                            className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                              (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="text-slate-700 flex flex-col items-center"><svg class="w-8 h-8 mb-2" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg><span class="text-xs">无缩略图</span></div>';
                            }}
                          />
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-indigo-900/40 transition-opacity">
                            <div className="bg-indigo-600 text-white rounded-full p-3 shadow-lg transform scale-90 group-hover:scale-100 transition-transform">
                              <Cast className="w-6 h-6" />
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="bg-slate-950 rounded-lg p-2.5 border border-slate-800 font-mono text-[10px] text-slate-500 truncate flex-1">
                            ID: {id}
                          </div>
                          <div className="bg-slate-950 rounded-lg p-2.5 border border-slate-800 font-mono text-[10px] text-indigo-400/80 truncate shrink-0 max-w-[100px]">
                            {device.os || 'Unknown OS'}
                          </div>
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
          <div className="absolute top-0 left-0 right-0 h-14 bg-slate-900/90 backdrop-blur-md border-b border-slate-700/50 z-40 flex items-center justify-between px-4 opacity-0 hover:opacity-100 transition-opacity duration-300" style={{ opacity: isFullscreen ? undefined : 1 }}>
            <div className="flex items-center gap-4">
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

            <div className="flex items-center bg-slate-950/50 rounded-lg border border-slate-800 p-1 gap-1">
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

            <div className="flex items-center gap-4">
              <div className="flex gap-4 text-xs font-mono text-slate-400 mr-2">
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase">FPS</span>
                  <span className={fps > 20 ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>{fps}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase">KB/s</span>
                  <span className="text-blue-400 font-bold">{dataRate}</span>
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

          <div className="flex-1 relative flex items-center justify-center overflow-hidden">
            <canvas 
              ref={canvasRef} 
              className="w-full h-full object-contain cursor-crosshair z-10"
              style={{ filter: qualityMode === 'smooth' ? 'contrast(1.05)' : 'none' }} // Fake visual feedback for modes
            />
            
            <div className="absolute bottom-6 right-6 flex gap-2 pointer-events-none z-30 opacity-70">
              <div className="bg-slate-900/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded text-[10px] text-slate-300 font-bold flex items-center gap-2">
                {keyboardCaptured ? <span className="text-emerald-400">⌨️ 已捕获</span> : "⌨️ 未捕获"}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
