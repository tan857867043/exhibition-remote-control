import React, { useState, useEffect, useRef, useCallback } from "react";
import ExhibitionRemoteClient from "./lib/ExhibitionRemoteClient.js";
import { Monitor, WifiOff, Settings, Mouse, Cast, Lock, Terminal, Router, X } from "lucide-react";

export default function App() {
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8080");
  const [devices, setDevices] = useState<string[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState<"disconnected" | "loading" | "connected">("disconnected");
  
  const [fps, setFps] = useState(0);
  const [dataRate, setDataRate] = useState(0);
  const [blockCount, setBlockCount] = useState(0);
  const [resolution, setResolution] = useState("--");
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  
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
  const clientRef = useRef<any>(null);
  
  const fpsCounterRef = useRef(0);
  const bytesReceivedRef = useRef(0);
  const blockCounterRef = useRef(0);

  const getDeviceName = (id: string) => deviceNames[id] || id;

  const loadDevices = async () => {
    setStatus("loading");
    try {
      const res = await fetch(`${serverUrl}/api/v1/devices`);
      const data = await res.json();
      setDevices(data);
      setStatus(currentDeviceId ? "connected" : "disconnected");
    } catch (e) {
      console.error(e);
      setStatus("disconnected");
      setDevices([]);
    }
  };

  useEffect(() => {
    loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectDevice = (deviceId: string) => {
    if (!deviceId) return;

    if (clientRef.current) {
      if (clientRef.current.ws) clientRef.current.ws.close();
      clientRef.current.releaseKeyboard();
    }

    setCurrentDeviceId(deviceId);
    
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

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  };

  useEffect(() => {
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
  }, []);

  const openDeviceDetails = (id: string) => {
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
    <div className="flex flex-col h-screen w-full overflow-hidden bg-slate-950 text-slate-200 font-sans">
      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Terminal className="w-5 h-5 text-emerald-500" />
                设备详情
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">系统设备 ID (不可更改)</label>
                <div className="bg-slate-950 border border-slate-800 px-3 py-2 rounded text-slate-400 font-mono text-sm">
                  <span>{editingDeviceId}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">自定义显示名称</label>
                <input 
                  type="text" 
                  value={editingName} 
                  onChange={(e) => setEditingName(e.target.value)} 
                  className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500/50 text-slate-200 placeholder-slate-600" 
                  placeholder="例如：大厅主屏幕" 
                />
              </div>
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">连接状态</span>
                  <span className="text-sm font-medium flex items-center gap-1">
                    {editingDeviceId === currentDeviceId ? (
                      <span className="text-emerald-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> 正在控制</span>
                    ) : (
                      <span className="text-slate-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span> 就绪</span>
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">数据加密</span>
                  <span className="text-sm font-medium text-slate-300 flex items-center gap-1">
                    <Lock className="w-4 h-4 text-emerald-500" /> 裸流直连
                  </span>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/50 flex justify-end gap-3">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors">取消</button>
              <button onClick={saveDeviceDetails} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-950 rounded text-xs font-bold uppercase tracking-wider transition-colors shadow-[0_0_12px_rgba(16,185,129,0.3)]">保存更改</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${status === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : status === 'loading' ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]' : 'bg-red-500'}`}></div>
            <span className="font-bold tracking-tight text-slate-100 flex items-center gap-2">
              <Monitor className="w-5 h-5 text-emerald-500" /> EXHIBITION REMOTE HUB <span className="text-slate-500 font-normal ml-2">v1.0.4-stable</span>
            </span>
          </div>
          <div className="h-4 w-px bg-slate-700"></div>
          <div className="flex items-center gap-2">
            <input 
              type="text" 
              value={serverUrl} 
              onChange={e => setServerUrl(e.target.value)} 
              className="bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-xs focus:outline-none focus:border-emerald-500/50 text-slate-300 w-56 font-mono" 
              placeholder="服务端地址" 
            />
            <button onClick={loadDevices} className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700 text-xs font-bold uppercase transition-all text-slate-300">刷新设备</button>
          </div>
        </div>
        <div className="flex items-center gap-6 text-xs">
          <div className="flex flex-col items-end">
            <span className="text-slate-500 uppercase font-bold tracking-wider text-[10px]">状态</span>
            <span className="font-mono text-slate-300 font-bold">
              {status === 'connected' ? '已连接' : status === 'loading' ? '加载中...' : '未连接'}
            </span>
          </div>
          {status === 'connected' && (
            <button onClick={disconnectDevice} className="px-4 py-2 bg-red-900/20 border border-red-500/30 text-red-400 rounded hover:bg-red-900/40 hover:text-red-300 font-bold uppercase transition-all tracking-wider text-[10px]">
              断开连接
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-72 bg-slate-900/50 border-r border-slate-800 flex flex-col">
          <div className="p-4 border-b border-slate-800">
            <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest flex justify-between items-center">
              <span>在线设备</span>
              <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">{devices.length}</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {devices.length === 0 ? (
              <div className="p-8 text-xs text-slate-500 text-center flex flex-col items-center gap-2">
                {status === 'disconnected' && !devices.length ? (
                  <>
                    <WifiOff className="w-8 h-8 opacity-30" />
                    <span>后端连接失败</span>
                  </>
                ) : (
                  <>
                    <Router className="w-8 h-8 opacity-30" />
                    <span>暂无设备在线</span>
                  </>
                )}
              </div>
            ) : (
              devices.map(id => {
                const isActive = id === currentDeviceId;
                const displayName = getDeviceName(id);
                return (
                  <div key={id} className={`p-4 transition-all group relative ${isActive ? 'bg-emerald-500/10 border-l-4 border-emerald-500' : 'border-b border-slate-800 hover:bg-slate-800/50 border-l-4 border-transparent'}`}>
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex flex-col cursor-pointer flex-1 overflow-hidden" onClick={() => connectDevice(id)}>
                        <span className={`font-bold text-sm truncate pr-2 ${isActive ? 'text-slate-100' : 'text-slate-400'}`}>{displayName}</span>
                        <span className="text-[10px] text-slate-600 font-mono mt-0.5 truncate">{id}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); openDeviceDetails(id); }} className="text-slate-500 hover:text-slate-300 transition-colors p-1 opacity-0 group-hover:opacity-100" title="设备详情 / 重命名">
                          <Settings className="w-4 h-4" />
                        </button>
                        {isActive ? (
                          <span className="text-[10px] bg-emerald-500 text-slate-950 px-1.5 py-0.5 rounded font-bold tracking-wider shadow-[0_0_8px_rgba(16,185,129,0.4)]">ACTIVE</span>
                        ) : (
                          <span className="text-[10px] border border-slate-600 text-slate-500 px-1.5 py-0.5 rounded font-bold tracking-wider">IDLE</span>
                        )}
                      </div>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-2 flex items-center gap-1 uppercase font-bold tracking-widest cursor-pointer w-fit hover:text-slate-400 transition-colors" onClick={() => connectDevice(id)}>
                      <Mouse className="w-3 h-3" /> Click to control
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="p-4 border-t border-slate-800 bg-slate-900 shrink-0">
            <div className="text-[10px] text-slate-500 mb-3 uppercase font-bold tracking-widest">终端网络统计</div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="flex flex-col bg-slate-950 p-2 border border-slate-800 rounded">
                <span className="text-slate-500 text-[10px] uppercase font-bold mb-1">FPS</span>
                <span className="text-slate-200 font-mono text-sm">{fps}</span>
              </div>
              <div className="flex flex-col bg-slate-950 p-2 border border-slate-800 rounded">
                <span className="text-slate-500 text-[10px] uppercase font-bold mb-1">速率 (KB/s)</span>
                <span className="text-emerald-400 font-mono text-sm">{dataRate}</span>
              </div>
              <div className="flex flex-col bg-slate-950 p-2 border border-slate-800 rounded">
                <span className="text-slate-500 text-[10px] uppercase font-bold mb-1">变化块</span>
                <span className="text-amber-400 font-mono text-sm">{blockCount}</span>
              </div>
              <div className="flex flex-col bg-slate-950 p-2 border border-slate-800 rounded">
                <span className="text-slate-500 text-[10px] uppercase font-bold mb-1">延迟 (ms)</span>
                <span className="text-blue-400 font-mono text-sm">--</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Remote View */}
        <section className="flex-1 flex flex-col bg-slate-950 relative">
          <div className="h-12 bg-slate-900/80 backdrop-blur border-b border-slate-800 flex items-center justify-between px-6 shrink-0 z-10">
            <div className="flex items-center gap-6">
              <span className="text-xs font-mono text-slate-500 flex items-center gap-2">
                当前控制: 
                <span className={status === 'connected' ? "text-emerald-400 bg-emerald-500/10 px-1.5 rounded" : "text-slate-500"}>
                  {status === 'connected' ? getDeviceName(currentDeviceId!) : '未连接'}
                </span>
              </span>
              <span className="text-xs font-mono text-slate-500 flex items-center gap-2">
                分辨率: <span className="text-blue-400">{resolution}</span>
              </span>
            </div>
            <div className="flex gap-2 text-xs font-mono bg-slate-950 border border-slate-800 px-3 py-1 rounded">
              <span className="text-emerald-400 font-bold">{fps} FPS</span>
            </div>
          </div>

          <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black p-4">
            <canvas 
              ref={canvasRef} 
              className="w-full h-full object-contain cursor-crosshair relative z-10 shadow-2xl"
            />

            {status !== 'connected' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-500 pointer-events-none transition-opacity z-20">
                <div className="w-32 h-32 mb-6 rounded-full bg-slate-900 flex items-center justify-center border border-slate-800 shadow-inner">
                  <Cast className="w-16 h-16 opacity-40" />
                </div>
                <span className="text-xl font-medium text-slate-300 mb-2 tracking-wide">等待建立连接...</span>
                <span className="text-sm">请在左侧列表选择一台设备以接收画面流</span>
              </div>
            )}

            <div className="absolute top-8 right-8 bg-slate-900/80 backdrop-blur border border-slate-800 p-3 rounded font-mono text-[10px] flex flex-col gap-1.5 pointer-events-none z-30 shadow-xl">
              <div className="flex justify-between gap-10"><span className="text-slate-500">PROTOCOL</span><span className="text-emerald-400">WS-BINARY</span></div>
              <div className="flex justify-between gap-10"><span className="text-slate-500">COMPRESSION</span><span className="text-amber-400">TurboJPEG</span></div>
              <div className="flex justify-between gap-10"><span className="text-slate-500">RENDERER</span><span className="text-blue-400">HTML5 Canvas</span></div>
            </div>
            
            <div className="absolute bottom-8 left-8 flex gap-3 pointer-events-none z-30">
              <div className="bg-slate-900/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded text-[10px] text-slate-400 font-bold uppercase tracking-widest shadow-xl flex items-center gap-1.5">
                {status === 'connected' ? (
                  <><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> <span className="text-emerald-400">流传输中</span></>
                ) : (
                  <><span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span> 未连接</>
                )}
              </div>
              <div className="bg-slate-900/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded text-[10px] text-slate-400 font-bold uppercase tracking-widest shadow-xl flex items-center gap-1.5">
                {keyboardCaptured ? <span className="text-emerald-400">键盘已捕获</span> : "键盘未捕获"}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
