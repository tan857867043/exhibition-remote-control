import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Folder, HardDrive, FolderPlus, Check, Loader2, AlertCircle, X, RefreshCw,
  Monitor, Pencil, CornerUpLeft, Home, FolderOpen,
} from "lucide-react";

/**
 * 远程目录选择器（RemoteDirPicker）——独立模态窗口
 *
 * 行业标准「现代文件夹选择对话框」布局（对应 Windows IFileDialog + FOS_PICKFOLDERS 的
 * 文件管理型风格），以**独立模态窗口**呈现（遮罩 + 居中对话框），通过原生 WebSocket
 * 直连目标设备（/api/v1/stream?device_id=），复用 Agent 的 list_dir / create_dir 协议：
 *   - 顶部可编辑面包屑路径栏（每级可点击；可切换文本输入直接键入完整路径）
 *   - 左侧导航窗格（此电脑 / 快捷位置）
 *   - 中部目录列表（名称 | 类型 | 修改时间，多列展示）
 *   - 交互规范：单击=选中当前目录（高亮并回填），双击=进入目录
 *   - 工具栏：向上 / 刷新 / 新建文件夹（create_dir，成功后刷新）
 *   - 底部「选择文件夹」按钮确认选定
 *
 * 组件自身渲染遮罩层（fixed inset-0），由调用方按需挂载（点「浏览」时显示、选完调用
 * onSelect 后卸载），不占用页面常驻空间。独立连接、自管理生命周期。
 */
interface RemoteDirEntry {
  name: string;
  size: number;
  is_dir: boolean;
  modified?: string;
  type?: string;
  label?: string;
}

interface RemoteDirPickerProps {
  serverUrl: string;
  deviceId: string;
  /** 当前目标路径（用于初始浏览位置与回填上下文） */
  value: string;
  /** 用户选定目录后回调 */
  onSelect: (dir: string) => void;
  /** 关闭/收起选择器（由父组件控制显隐） */
  onClose?: () => void;
  /** 可选的设备显示名（显示在标题栏） */
  deviceName?: string;
}

// 路径规范化：忽略尾部反斜杠差异（盘符根 "D:\" 与 "D:" 视为同一路径，"" 保持为空）
const normPath = (p?: string) => (p || "").replace(/\\+$/, "");

const fmtSize = (bytes?: number) => {
  if (bytes === undefined) return "--";
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
};

const fmtDate = (modified?: string) => {
  if (!modified) return "--";
  const t = parseInt(modified, 10);
  if (!t || t === 0) return "--";
  const d = new Date(t * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const RemoteDirPicker: React.FC<RemoteDirPickerProps> = ({
  serverUrl,
  deviceId,
  value,
  onSelect,
  onClose,
  deviceName,
}) => {
  const [browsePath, setBrowsePath] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editPathMode, setEditPathMode] = useState(false);
  const [editPathInput, setEditPathInput] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const browsePathRef = useRef("");
  const requestIdRef = useRef(0);
  const loadDirTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Esc 关闭（与 FileManager 内嵌选择器保持一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const wsProtocol = serverUrl.startsWith("https") ? "wss" : "ws";
    const host = serverUrl.replace(/^https?:\/\//, "");
    const ws = new WebSocket(`${wsProtocol}://${host}/api/v1/stream?device_id=${deviceId}`);
    wsRef.current = ws;
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data);
        // 仅处理与当前请求路径一致的响应：agent 会向该设备所有订阅者广播
        // list_dir_result，若不匹配则跳过，避免多连接（或 FileManager 通道）串扰列表。
        // 盘符等路径存在尾反斜杠差异（请求 "D:\"、响应 "D:"），故用规范化比较
        if (msg.action === "list_dir_result") {
          if (normPath(msg.path) !== normPath(browsePathRef.current)) return;
          if (loadDirTimeoutRef.current) { clearTimeout(loadDirTimeoutRef.current); loadDirTimeoutRef.current = null; }
          setLoading(false);
          setError("");
          setEntries(msg.entries || []);
          setSelected(browsePathRef.current);
        } else if (msg.action === "list_dir_error") {
          if (normPath(msg.path) !== normPath(browsePathRef.current)) return;
          if (loadDirTimeoutRef.current) { clearTimeout(loadDirTimeoutRef.current); loadDirTimeoutRef.current = null; }
          setLoading(false);
          setError(msg.error || "无法读取远程目录");
        }
      } catch (_) { /* ignore */ }
    };
    ws.onerror = () => setError("远程连接失败（WebSocket 错误）");
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [serverUrl, deviceId]);

  useEffect(() => { connect(); }, [connect]);
  useEffect(() => () => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const loadDir = useCallback((path: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setTimeout(() => loadDir(path), 300);
      return;
    }
    setLoading(true);
    setError("");
    browsePathRef.current = path;
    setBrowsePath(path);
    setSelected(path);
    requestIdRef.current += 1;
    ws.send(JSON.stringify({ action: "list_dir", path }));
    // 超时兜底：agent 不响应时停止 loading 并提示，避免永久转圈
    if (loadDirTimeoutRef.current) clearTimeout(loadDirTimeoutRef.current);
    loadDirTimeoutRef.current = setTimeout(() => {
      setLoading(false);
      setError("加载远程目录超时，请重试");
    }, 30000);
  }, []);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      loadDir(browsePathRef.current || value || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goUp = () => {
    const p = browsePathRef.current;
    if (!p) return;
    const parts = p.split("\\").filter(Boolean);
    if (parts.length <= 1) { loadDir(""); return; }
    let parent = parts.slice(0, -1).join("\\");
    if (/^[A-Za-z]:$/.test(parent)) parent += "\\"; // 盘符根补尾反斜杠，如 D:\
    loadDir(parent);
  };

  const crumbs = browsePath.split("\\").filter(Boolean);

  const handleClickEntry = (entry: RemoteDirEntry) => {
    if (entry.is_dir) {
      setSelected(browsePath ? `${browsePath}\\${entry.name}` : entry.name);
    }
  };

  const handleDoubleClickEntry = (entry: RemoteDirEntry) => {
    if (!entry.is_dir) return;
    const next = browsePath ? `${browsePath}\\${entry.name}` : entry.name;
    loadDir(next);
  };

  const handlePick = () => {
    onSelect(selected || browsePath || "");
  };

  const handleEditPathCommit = () => {
    setEditPathMode(false);
    loadDir(editPathInput.trim() || "");
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const full = browsePath ? `${browsePath}\\${name}` : name;
    ws.send(JSON.stringify({ action: "create_dir", path: full }));
    setNewFolderName("");
    setShowNewFolder(false);
    // 立即刷新：list_dir_result 到达后自然更新；若 agent 不响应由 30s 超时兜底提示
    loadDir(browsePathRef.current);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-popover border border-border rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* 标题栏 */}
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="w-4 h-4 text-primary flex-shrink-0" />
            <h3 className="text-sm font-semibold text-foreground">选择文件夹</h3>
            {deviceName && (
              <span className="text-[11px] text-muted-foreground truncate">（{deviceName}）</span>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* ── 顶部工具栏：路径栏（面包屑/编辑）+ 操作 ── */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border flex-wrap flex-shrink-0">
          <button
            onClick={() => loadDir("")}
            title="此电脑（盘符）"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={goUp}
            disabled={!browsePath}
            title="上级目录"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
          >
            <CornerUpLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => loadDir(browsePathRef.current)}
            title="刷新"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          <div className="flex-1 min-w-0 flex items-center gap-1">
            {editPathMode ? (
              <input
                autoFocus
                type="text"
                value={editPathInput}
                onChange={(e) => setEditPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleEditPathCommit(); if (e.key === "Escape") setEditPathMode(false); }}
                placeholder="输入完整路径，如 D:\Downloads"
                className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-primary/50"
              />
            ) : crumbs.length === 0 ? (
              <span className="text-[11px] text-muted-foreground flex-1">此电脑</span>
            ) : (
              <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
                {crumbs.map((c, i) => {
                  let crumbPath = crumbs.slice(0, i + 1).join("\\");
                  if (/^[A-Za-z]:$/.test(crumbPath)) crumbPath += "\\"; // 盘符根补尾反斜杠
                  return (
                    <React.Fragment key={i}>
                      <button
                        className="text-[11px] px-1 py-0.5 rounded text-foreground hover:bg-muted whitespace-nowrap"
                        onClick={() => loadDir(crumbPath)}
                        title={crumbPath}
                      >
                        {c}
                      </button>
                      {i < crumbs.length - 1 && <span className="text-muted-foreground/60 text-[10px]">/</span>}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => { setEditPathInput(browsePath); setEditPathMode(v => !v); }}
              title="编辑路径（直接输入完整路径）"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>

          <button
            onClick={() => setShowNewFolder(v => !v)}
            title="新建文件夹"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* ── 新建文件夹输入 ── */}
        {showNewFolder && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
            <input
              autoFocus
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); }}
              placeholder="新文件夹名称（将创建于当前目录）"
              className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs focus:outline-none focus:border-primary/50"
            />
            <button onClick={handleCreateFolder} className="px-2 py-1 rounded text-[11px] bg-primary text-primary-foreground hover:opacity-90 transition-opacity">
              创建
            </button>
          </div>
        )}

        {/* ── 主体：左侧导航窗格 + 中部目录列表 ── */}
        <div className="flex flex-1 min-h-0">
          <div className="w-24 flex-shrink-0 border-r border-border p-1.5 space-y-0.5 bg-background/40 overflow-y-auto">
            <button
              onClick={() => loadDir("")}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] hover:bg-muted transition-colors text-foreground"
              title="此电脑（所有盘符）"
            >
              <Monitor className="w-3 h-3 text-primary/70" /> 此电脑
            </button>
            <button
              onClick={() => loadDir("D:\\")}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] hover:bg-muted transition-colors text-foreground"
              title="D 盘"
            >
              <HardDrive className="w-3 h-3 text-primary/70" /> D 盘
            </button>
            <button
              onClick={() => loadDir("C:\\")}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] hover:bg-muted transition-colors text-foreground"
              title="C 盘"
            >
              <HardDrive className="w-3 h-3 text-primary/70" /> C 盘
            </button>
            <div className="pt-1.5 mt-1.5 border-t border-border text-[10px] text-muted-foreground px-1">快捷位置</div>
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-muted-foreground border-b border-border font-medium flex-shrink-0">
              <span className="flex-1 min-w-0">名称</span>
              <span className="w-14 flex-shrink-0">类型</span>
              <span className="w-24 flex-shrink-0 text-right">修改时间</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-1 space-y-0.5">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-xs">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载远程目录…
                </div>
              ) : error ? (
                <div className="flex items-center gap-2 py-4 px-2 text-xs" style={{ color: 'var(--ur-danger)' }}>
                  <AlertCircle className="w-3.5 h-3.5" /> {error}
                </div>
              ) : entries.length === 0 ? (
                <div className="py-5 text-center text-xs text-muted-foreground">（空目录 / 无盘符）</div>
              ) : (
                entries.map((entry, idx) => {
                  const fullPath = browsePath ? `${browsePath}\\${entry.name}` : entry.name;
                  const isSelected = selected === fullPath;
                  const isDisk = entry.type === "disk";
                  return (
                    <div
                      key={`${entry.name}-${idx}`}
                      onClick={() => handleClickEntry(entry)}
                      onDoubleClick={() => handleDoubleClickEntry(entry)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleDoubleClickEntry(entry); } }}
                      className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors select-none"
                      style={{
                        background: isSelected ? 'rgba(37,99,235,0.08)' : 'transparent',
                        outline: isSelected ? '1px solid rgba(37,99,235,0.5)' : 'none'
                      }}
                      title={`双击进入 ${entry.name}`}
                    >
                      <span className="flex-1 min-w-0 flex items-center gap-2">
                        {isDisk
                          ? <HardDrive className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
                          : <Folder className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />}
                        <span className="truncate text-xs text-foreground">{entry.label || entry.name}</span>
                      </span>
                      <span className="w-14 flex-shrink-0 text-[10px] text-muted-foreground">
                        {isDisk ? <span className="inline-flex items-center gap-0.5"><HardDrive className="w-2.5 h-2.5" />磁盘</span> : <span className="inline-flex items-center gap-0.5"><Folder className="w-2.5 h-2.5" />文件夹</span>}
                      </span>
                      <span className="w-24 flex-shrink-0 text-[10px] text-muted-foreground text-right">{fmtDate(entry.modified)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ── 底部：当前选中路径 + 「选择文件夹」 ── */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-border flex-shrink-0">
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <Home className="w-3 h-3 text-muted-foreground flex-shrink-0" />
            <span className="text-[11px] text-muted-foreground font-mono truncate" title={selected || browsePath}>
              {selected || browsePath || "（盘符根）"}
            </span>
          </div>
          <button
            onClick={handlePick}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-[11px] bg-primary text-primary-foreground hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            <Check className="w-3 h-3" /> 选择文件夹
          </button>
        </div>
      </div>
    </div>
  );
};