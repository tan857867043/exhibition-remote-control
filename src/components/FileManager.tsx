import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Folder, File, ChevronUp, RefreshCw, FolderPlus, Trash2, X, Minus,
  ArrowLeft, HardDrive, ChevronDown,
  Upload, Download, Play, Pause, Ban, Eraser, Monitor,
  Usb, Network, Disc, Pencil,
  FileText, FileImage, FileVideo, FileAudio, FileCode, FileArchive,
  FileSpreadsheet, FileJson, FileQuestion,
} from "lucide-react";
import { toast, confirmDialog as showConfirmDialog, promptDialog } from "../lib/ui";

interface FileEntry {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  type?: string;
  disk_type?: string;
  free?: number;
  label?: string;
}

export interface TransferTaskItem {
  id: string;
  name: string;
  size: number;
  direction: "upload" | "download";
  sourcePath: string;
  targetPath: string;
  progress: number;
  speed: number;
  status: "pending" | "transferring" | "completed" | "failed" | "paused";
  error?: string;
  deviceId?: string;
  deviceName?: string;
}

type OverwriteStrategy = "skip" | "overwrite" | "rename";

interface ConfirmDialogState {
  mode: "upload" | "download";
  files: (File | FileEntry)[];
  targetPath: string;
  overwriteStrategy: OverwriteStrategy;
}

interface FileManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onTasksChange?: (tasks: TransferTaskItem[]) => void;
  tasks?: TransferTaskItem[];
  setTasks?: React.Dispatch<React.SetStateAction<TransferTaskItem[]>>;
  clientRef: React.MutableRefObject<any>;
  deviceName: string;
}

const fmtSize = (bytes: number) => {
  if (bytes === 0) return "--";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const fmtDate = (ts: string) => {
  if (!ts) return "--";
  const t = parseInt(ts, 10);
  if (isNaN(t) || t === 0) return "--";
  const d = new Date(t * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatETA = (seconds: number): string => {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return `${h}h ${m}m`;
};

const getProgressColor = (status: TransferTaskItem["status"]): string => {
  switch (status) {
    case "transferring": return "bg-primary";
    case "completed": return "bg-success";
    case "failed": return "bg-error";
    case "paused": return "bg-warning";
    default: return "bg-muted-foreground";
  }
};

const getFileType = (entry: FileEntry): string => {
  if (entry.type === "disk") {
    const typeMap: Record<string, string> = {
      removable: "可移动磁盘",
      fixed: "本地磁盘",
      network: "网络驱动器",
      cdrom: "DVD/CD 驱动器",
      ramdisk: "内存磁盘",
      unknown: "磁盘",
    };
    return typeMap[entry.disk_type || "unknown"] || "本地磁盘";
  }
  if (entry.is_dir) return "文件夹";
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  const extMap: Record<string, string> = {
    exe: "应用程序", dll: "应用程序扩展", bat: "Windows 批处理",
    txt: "文本文档", doc: "Word 文档", docx: "Word 文档",
    xls: "Excel 表格", xlsx: "Excel 表格", pdf: "PDF 文档",
    ppt: "PowerPoint", pptx: "PowerPoint",
    jpg: "JPG 图片", jpeg: "JPEG 图片", png: "PNG 图片",
    gif: "GIF 图片", bmp: "BMP 图片", webp: "WebP 图片",
    mp4: "MP4 视频", avi: "AVI 视频", mkv: "MKV 视频", mov: "MOV 视频",
    mp3: "MP3 音频", wav: "WAV 音频", flac: "FLAC 音频",
    zip: "压缩包", rar: "压缩包", "7z": "压缩包", tar: "压缩包", gz: "压缩包",
    js: "JavaScript", ts: "TypeScript", jsx: "React JSX", tsx: "React TSX",
    css: "样式表", html: "网页", json: "JSON 文件", py: "Python 文件",
    rs: "Rust 文件", go: "Go 文件",
  };
  return extMap[ext] || `${ext.toUpperCase()} 文件`;
};

const getFileIcon = (entry: FileEntry): { Icon: React.ComponentType<any>; color: string } => {
  if (entry.type === "disk") return { Icon: HardDrive, color: "text-muted-foreground" };
  if (entry.is_dir) return { Icon: Folder, color: "text-amber-500" };
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";

  const imageExts = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif"];
  if (imageExts.includes(ext)) return { Icon: FileImage, color: "text-warning" };

  const videoExts = ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "3gp"];
  if (videoExts.includes(ext)) return { Icon: FileVideo, color: "text-primary" };

  const audioExts = ["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "ape"];
  if (audioExts.includes(ext)) return { Icon: FileAudio, color: "text-emerald-500" };

  const codeExts = ["js", "ts", "jsx", "tsx", "css", "html", "py", "rs", "go", "java", "c", "cpp", "h", "rb", "php", "swift", "kt", "vue", "svelte"];
  if (codeExts.includes(ext)) return { Icon: FileCode, color: "text-blue-500" };

  const archiveExts = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"];
  if (archiveExts.includes(ext)) return { Icon: FileArchive, color: "text-amber-600" };

  const sheetExts = ["xls", "xlsx", "csv", "ods"];
  if (sheetExts.includes(ext)) return { Icon: FileSpreadsheet, color: "text-green-600" };

  const docExts = ["doc", "docx", "txt", "md", "rtf", "pdf", "ppt", "pptx"];
  if (docExts.includes(ext)) return { Icon: FileText, color: "text-blue-600" };

  if (ext === "json") return { Icon: FileJson, color: "text-yellow-600" };

  return { Icon: FileQuestion, color: "text-muted-foreground" };
};

async function traverseEntry(entry: FileSystemEntry, relativePath: string, result: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve) => {
      (entry as FileSystemFileEntry).file((f) => {
        (f as any)._relativePath = relativePath;
        resolve(f);
      });
    });
    result.push(file);
  } else if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const getEntries = (): Promise<FileSystemEntry[]> => new Promise((resolve) => {
      const all: FileSystemEntry[] = [];
      const readBatch = () => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) { resolve(all); return; }
          all.push(...batch);
          readBatch();
        });
      };
      readBatch();
    });
    const entries = await getEntries();
    const subPath = relativePath ? `${relativePath}\\${entry.name}` : entry.name;
    for (const subEntry of entries) {
      await traverseEntry(subEntry, subPath, result);
    }
  }
}

async function collectDraggedFiles(items: DataTransferItemList): Promise<File[]> {
  const result: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      const file = item.getAsFile();
      if (file) result.push(file);
      continue;
    }
    await traverseEntry(entry, "", result);
  }
  return result;
}

const Breadcrumb = ({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) => {
  if (!path) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <HardDrive className="w-3.5 h-3.5" />
        <span>此电脑</span>
        <ChevronDown className="w-3 h-3" />
      </div>
    );
  }
  const parts = path.split("\\").filter(Boolean);
  return (
    <div className="flex items-center gap-1 overflow-x-auto text-xs">
      <button onClick={() => onNavigate("")} className="flex items-center gap-1 text-muted-foreground hover:text-foreground shrink-0 px-1 py-0.5 rounded hover:bg-muted">
        <HardDrive className="w-3 h-3" /> 此电脑
      </button>
      <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
      {parts.map((part, idx) => {
        const fullPath = parts.slice(0, idx + 1).join("\\") + "\\";
        const isLast = idx === parts.length - 1;
        return (
          <React.Fragment key={idx}>
            <button onClick={() => onNavigate(fullPath)}
              className={`px-1 py-0.5 rounded shrink-0 ${isLast ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
              {part}
            </button>
            {!isLast && <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0 -rotate-90" />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

interface FilePaneProps {
  entries: FileEntry[];
  selected: Set<string>;
  onToggleSelect: (name: string, e: React.MouseEvent) => void;
  isRemote: boolean;
  remoteLoading?: boolean;
  onContextMenu?: (e: React.MouseEvent, name: string, isDir: boolean) => void;
  onNavigate?: (path: string) => void;
  remotePath?: string;
  onDownload?: (name: string) => void;
}

const FilePane: React.FC<FilePaneProps> = ({
  entries, selected, onToggleSelect, isRemote, remoteLoading, onContextMenu, onNavigate, remotePath, onDownload,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card border-b border-border z-10">
          <tr className="text-muted-foreground">
            <th className="w-8 py-1.5 px-1.5 text-left font-normal">
              <input type="checkbox" className="rounded" readOnly />
            </th>
            <th className="py-1.5 px-1.5 text-left font-normal">名称</th>
            <th className="py-1.5 px-1.5 text-left font-normal w-36">修改日期</th>
            <th className="py-1.5 px-1.5 text-left font-normal w-28">类型</th>
            <th className="py-1.5 px-1.5 text-right font-normal w-20">大小</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={5} className="text-center py-12">
                {isRemote ? (
                  <span className="text-muted-foreground">{remoteLoading ? "加载中..." : "此文件夹为空"}</span>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <Upload className="w-10 h-10 text-muted-foreground opacity-50" />
                    <div className="text-muted-foreground text-sm">拖拽文件到此窗口，或点击右上角按钮选择文件</div>
                    <div className="text-muted-foreground text-xs">浏览器出于安全限制无法直接访问本地文件系统</div>
                  </div>
                )}
              </td>
            </tr>
          ) : (
            entries.map((entry) => {
              const isSelected = selected.has(entry.name);
              const isDisk = entry.type === "disk";
              const isDir = entry.is_dir;
              return (
                <tr key={entry.name}
                  className={`border-b border-border cursor-pointer hover:bg-muted`}
                  style={isSelected ? { background: 'rgba(37,99,235,0.15)' } : undefined}
                  onClick={(e) => {
                    if (isDisk) {
                      if (isRemote && onNavigate) onNavigate(entry.name);
                    } else if (isDir) {
                      if (isRemote && onNavigate && remotePath !== undefined) onNavigate(`${remotePath}\\${entry.name}`);
                    }
                  }}
                  onDoubleClick={(e) => {
                    if (isDisk) {
                      if (isRemote && onNavigate) onNavigate(entry.name);
                    } else if (isDir) {
                      if (isRemote && onNavigate && remotePath !== undefined) onNavigate(`${remotePath}\\${entry.name}`);
                    } else {
                      if (isRemote && onDownload) onDownload(entry.name);
                    }
                  }}
                  onContextMenu={(e) => {
                    if (isRemote && !isDisk && onContextMenu) {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenu(e, entry.name, isDir);
                    }
                  }}>
                  <td className="py-1 px-1.5">
                    <input type="checkbox" className="rounded"
                      checked={isSelected}
                      onChange={(e) => onToggleSelect(entry.name, e as any)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className="py-1 px-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isDisk ? (
                        entry.disk_type === "removable" ? (
                          <Usb className="w-4 h-4 text-emerald-500 shrink-0" />
                        ) : entry.disk_type === "network" ? (
                          <Network className="w-4 h-4 text-blue-500 shrink-0" />
                        ) : entry.disk_type === "cdrom" ? (
                          <Disc className="w-4 h-4 text-amber-500 shrink-0" />
                        ) : (
                          <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                        )
                      ) : (
                        (() => {
                          const { Icon, color } = getFileIcon(entry);
                          return <Icon className={`w-4 h-4 ${color} shrink-0`} />;
                        })()
                      )}
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {isDisk ? (
                            <>
                              <span className="truncate text-foreground font-medium">
                                {entry.label || entry.name.replace("\\", "")}
                              </span>
                              <span className="text-muted-foreground text-xs shrink-0">
                                ({entry.name.replace("\\", "")})
                              </span>
                            </>
                          ) : (
                            <span className="truncate text-foreground">{entry.name}</span>
                          )}
                        </div>
                        {isDisk && entry.size > 0 && (
                          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                            <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden min-w-[60px]">
                              <div
                                className={`h-full rounded-full ${
                                  (1 - (entry.free || 0) / entry.size) > 0.9
                                    ? "bg-error"
                                    : (1 - (entry.free || 0) / entry.size) > 0.75
                                    ? "bg-warning"
                                    : "bg-success"
                                }`}
                                style={{ width: `${Math.round((1 - (entry.free || 0) / entry.size) * 100)}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-muted-foreground shrink-0 font-mono whitespace-nowrap">
                              可用 {fmtSize(entry.free || 0)} / {fmtSize(entry.size)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-1 px-1.5 text-muted-foreground">{fmtDate(entry.modified)}</td>
                  <td className="py-1 px-1.5 text-muted-foreground">{getFileType(entry)}</td>
                  <td className="py-1 px-1.5 text-muted-foreground text-right font-mono">
                    {isDisk ? (entry.size > 0 ? fmtSize(entry.size) : "--") : isDir ? "--" : fmtSize(entry.size)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};

export const FileManager: React.FC<FileManagerProps> = ({ isOpen, onClose, onMinimize, onTasksChange, tasks: propsTasks, setTasks: propsSetTasks, clientRef, deviceName }) => {
  const [pendingUploads, setPendingUploads] = useState<File[]>([]);

  const [remotePath, setRemotePath] = useState("");
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);

  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());

  const [localTasks, setLocalTasks] = useState<TransferTaskItem[]>([]);
  const transferTasks = propsTasks || localTasks;
  const setTransferTasks = propsSetTasks || setLocalTasks;

  const [flashingTasks, setFlashingTasks] = useState<Set<string>>(new Set());
  const prevStatusRef = useRef<Record<string, TransferTaskItem["status"]>>({});

  const totalProgress = useMemo(() => {
    const totalSize = transferTasks.reduce((sum, t) => sum + (t.size || 0), 0);
    if (totalSize === 0) return { percent: 0, doneStr: "0 B", totalStr: "0 B" };
    const doneSize = transferTasks.reduce((sum, t) => {
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
      doneStr: fmt(doneSize),
      totalStr: fmt(totalSize),
    };
  }, [transferTasks]);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetName: string; isDir: boolean } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<OverwriteStrategy>("skip");
  const [confirmTargetInput, setConfirmTargetInput] = useState("");
  const pendingUploadFilesRef = useRef<File[]>([]);

  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [dirPickerPath, setDirPickerPath] = useState("");
  const [dirPickerEntries, setDirPickerEntries] = useState<FileEntry[]>([]);
  const [dirPickerLoading, setDirPickerLoading] = useState(false);
  const dirPickerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirPickerOpenRef = useRef(false);
  useEffect(() => { dirPickerOpenRef.current = dirPickerOpen; }, [dirPickerOpen]);
  const [dirPickerSelected, setDirPickerSelected] = useState<string | null>(null);
  const [dirPickerError, setDirPickerError] = useState("");
  const [dirPickerShowNewFolder, setDirPickerShowNewFolder] = useState(false);
  const [dirPickerNewFolderName, setDirPickerNewFolderName] = useState("");

  // 目录选择弹窗打开期间支持 Esc 关闭
  useEffect(() => {
    if (!dirPickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDirPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirPickerOpen]);

  const remotePathRef = useRef(remotePath);
  useEffect(() => { remotePathRef.current = remotePath; }, [remotePath]);

  // 文件管理器打开时禁用远程控制输入，关闭时恢复
  useEffect(() => {
    if (isOpen) {
      clientRef.current?.disableInput?.();
    } else {
      clientRef.current?.enableInput?.();
    }
  }, [isOpen, clientRef]);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remoteEntriesRef = useRef<FileEntry[]>([]);
  useEffect(() => { remoteEntriesRef.current = remoteEntries; }, [remoteEntries]);

  useEffect(() => {
    const currentIds = new Set(transferTasks.map(t => t.id));
    for (const id of Object.keys(prevStatusRef.current)) {
      if (!currentIds.has(id)) {
        delete prevStatusRef.current[id];
      }
    }
    for (const task of transferTasks) {
      const prevStatus = prevStatusRef.current[task.id];
      if (prevStatus && prevStatus !== task.status) {
        if ((prevStatus === "transferring" || prevStatus === "pending") &&
            (task.status === "completed" || task.status === "failed")) {
          setFlashingTasks(prev => {
            const next = new Set(prev);
            next.add(task.id);
            return next;
          });
          setTimeout(() => {
            setFlashingTasks(prev => {
              const next = new Set(prev);
              next.delete(task.id);
              return next;
            });
          }, 1500);
        }
      }
      prevStatusRef.current[task.id] = task.status;
    }
  }, [transferTasks]);

  useEffect(() => {
    onTasksChange?.(transferTasks);
  }, [transferTasks, onTasksChange]);

  const handleMessage = useCallback((msg: any) => {
    console.log("[FileManager] handleMessage received:", msg.action, msg);
    if (msg.action === "list_dir_result") {
      console.log("[FileManager] list_dir_result received, entries count:", msg.entries?.length || 0);
      const newEntries = msg.entries || [];
      if (dirPickerOpenRef.current) {
        setDirPickerEntries(newEntries);
        setDirPickerLoading(false);
        setDirPickerError("");
        if (dirPickerTimeoutRef.current) { clearTimeout(dirPickerTimeoutRef.current); dirPickerTimeoutRef.current = null; }
      } else {
        const oldEntries = remoteEntriesRef.current;
        const hasChanged = newEntries.length !== oldEntries.length ||
          newEntries.some((e: FileEntry, i: number) => {
            const o = oldEntries[i];
            return !o || e.name !== o.name || e.size !== o.size || e.modified !== o.modified;
          });
        if (hasChanged) {
          setRemoteEntries(newEntries);
        }
        setRemoteLoading(false);
        if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }
      }
    } else if (msg.action === "list_dir_error") {
      console.log("[FileManager] list_dir_error:", msg.error);
      if (dirPickerOpenRef.current) {
        setDirPickerEntries([]);
        setDirPickerLoading(false);
        setDirPickerError(msg.error || "无法读取远程目录");
        if (dirPickerTimeoutRef.current) { clearTimeout(dirPickerTimeoutRef.current); dirPickerTimeoutRef.current = null; }
      } else {
        setRemoteEntries([]);
        setRemoteLoading(false);
        if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }
      }
    } else if (msg.action === "delete_file_result") {
      if (clientRef.current?.ws && clientRef.current.ws.readyState === 1) {
        setRemoteLoading(true);
        clientRef.current.ws.send(JSON.stringify({ action: "list_dir", path: remotePathRef.current }));
      }
    }
  }, [clientRef]);

  const ensureCallback = useCallback(() => {
    if (clientRef.current) {
      console.log("[FileManager] Setting callback on current client");
      clientRef.current.setFileManagerCallback(handleMessage);
    }
  }, [clientRef, handleMessage]);

  useEffect(() => {
    ensureCallback();
    const interval = setInterval(ensureCallback, 2000);
    return () => {
      clearInterval(interval);
      clientRef.current?.setFileManagerCallback(null);
    };
  }, [ensureCallback]);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener("click", handleGlobalClick);
      return () => window.removeEventListener("click", handleGlobalClick);
    }
  }, [contextMenu]);

  const loadRemoteDir = useCallback(async (path: string) => {
    console.log("[FileManager] loadRemoteDir called, path:", path, "ws readyState:", clientRef.current?.ws?.readyState);
    ensureCallback();
    if (!clientRef.current?.ws || clientRef.current.ws.readyState !== 1) {
      console.log("[FileManager] WebSocket not ready, aborting");
      return;
    }
    setRemoteLoading(true);
    setRemotePath(path);
    setSelectedRemote(new Set());
    const msg = JSON.stringify({ action: "list_dir", path });
    console.log("[FileManager] Sending:", msg);
    clientRef.current.ws.send(msg);
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
    loadTimeoutRef.current = setTimeout(() => {
      console.log("[FileManager] list_dir timed out after 30s");
      setRemoteLoading(false);
    }, 30000);
  }, [clientRef]);

  useEffect(() => {
    if (isOpen) {
      loadRemoteDir("");
    }
  }, [isOpen, loadRemoteDir]);

  const loadDirPicker = useCallback(async (path: string) => {
    if (!clientRef.current?.ws || clientRef.current.ws.readyState !== 1) return;
    setDirPickerLoading(true);
    setDirPickerError("");
    setDirPickerPath(path);
    setDirPickerSelected(path);
    const msg = JSON.stringify({ action: "list_dir", path });
    clientRef.current.ws.send(msg);
    if (dirPickerTimeoutRef.current) clearTimeout(dirPickerTimeoutRef.current);
    dirPickerTimeoutRef.current = setTimeout(() => {
      setDirPickerLoading(false);
      setDirPickerError("加载远程目录超时，请稍后重试");
    }, 30000);
  }, [clientRef]);

  const handleDirPickerUp = () => {
    if (!dirPickerPath) return;
    const parts = dirPickerPath.split("\\").filter(Boolean);
    if (parts.length <= 1) {
      loadDirPicker("");
    } else {
      const parent = parts.slice(0, -1).join("\\") + "\\";
      loadDirPicker(parent);
    }
  };

  const handleDirPickerCreateFolder = () => {
    const name = dirPickerNewFolderName.trim();
    if (!name || !clientRef.current?.ws) return;
    const fullPath = dirPickerPath ? `${dirPickerPath}\\${name}` : name;
    clientRef.current.ws.send(JSON.stringify({ action: "create_dir", path: fullPath }));
    setDirPickerNewFolderName("");
    setDirPickerShowNewFolder(false);
    // 立即刷新：list_dir_result 到达后自然更新；失败由 30s 超时兜底提示
    loadDirPicker(dirPickerPath);
  };

  const handleRemoteUp = () => {
    if (!remotePath) return;
    const parts = remotePath.split("\\").filter(Boolean);
    if (parts.length <= 1) {
      loadRemoteDir("");
    } else {
      const parent = parts.slice(0, -1).join("\\") + "\\";
      loadRemoteDir(parent);
    }
  };

  const handleRemoteBack = handleRemoteUp;

  const handleCreateRemoteFolder = async () => {
    const name = await promptDialog("请输入文件夹名称：");
    if (!name || !clientRef.current?.ws) return;
    const fullPath = remotePath ? `${remotePath}\\${name}` : name;
    clientRef.current.ws.send(JSON.stringify({ action: "create_dir", path: fullPath }));
    setTimeout(() => loadRemoteDir(remotePath), 500);
  };

  const handleDeleteRemote = async (name: string) => {
    if (!clientRef.current?.ws) return;
    const fullPath = remotePath ? `${remotePath}\\${name}` : name;
    if (!(await showConfirmDialog(`确认删除 ${name}?`, { danger: true }))) return;
    clientRef.current.ws.send(JSON.stringify({ action: "delete_file", path: fullPath }));
  };

  const handleRenameRemote = async (oldName: string) => {
    const newName = await promptDialog("请输入新名称：", oldName);
    if (!newName || !clientRef.current?.ws || newName === oldName) return;
    clientRef.current.ws.send(JSON.stringify({ action: "rename", path: remotePath, oldname: oldName, newname: newName }));
    setTimeout(() => loadRemoteDir(remotePath), 500);
  };

  const handlePauseTask = (taskId: string) => {
    clientRef.current?.pauseTransfer();
    setTransferTasks(prev => prev.map(t =>
      t.id === taskId && t.status === "transferring" ? { ...t, status: "paused" } : t
    ));
  };

  const handleResumeTask = (taskId: string) => {
    clientRef.current?.resumeTransfer();
    setTransferTasks(prev => prev.map(t =>
      t.id === taskId && (t.status === "paused" || t.status === "failed") ? { ...t, status: "transferring" } : t
    ));
  };

  const handleCancelTask = (taskId: string) => {
    clientRef.current?.cancelTransfer();
    setTransferTasks(prev => prev.map(t =>
      t.id === taskId && (t.status === "transferring" || t.status === "pending" || t.status === "paused")
        ? { ...t, status: "failed", error: "已取消" } : t
    ));
  };

  const startUpload = async (files: File[], targetPath: string, overwrite: OverwriteStrategy) => {
    // 上传前探测远端目标路径：不存在时提示用户确认是否自动创建
    if (targetPath) {
      try {
        const exists = await clientRef.current?.checkDirExists?.(targetPath);
        if (exists === false) {
          const shouldCreate = await showConfirmDialog(
            `远端路径 "${targetPath}" 不存在。\n是否自动创建该目录后继续上传？`
          );
          if (!shouldCreate) {
            toast("已取消上传，请修改远程保存路径后重试。", "info");
            return;
          }
          clientRef.current?.createDir?.(targetPath);
        }
      } catch (err) {
        console.warn("[FileManager] 目录探测失败，继续上传（Agent 兜底创建）:", err);
      }
    }

    const directories = new Set<string>();
    const filesWithTargets: { file: File; targetDir: string; displayName: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // 统一相对路径分隔符为反斜杠（webkitdirectory 选择/部分拖拽场景返回正斜杠，会破坏 Windows 路径层级）
      const relPath = (((file as any).webkitRelativePath || (file as any)._relativePath || '') as string).replace(/[\\/]/g, '\\');
      let fileTargetDir = targetPath;
      let displayName = file.name;

      if (relPath) {
        const subDir = relPath.replace(/\\/g, '\\');
        if (subDir) {
          fileTargetDir = targetPath ? `${targetPath}\\${subDir}` : subDir;
          directories.add(fileTargetDir);
        }
        displayName = relPath.replace(/\//g, '\\');
      }

      filesWithTargets.push({ file, targetDir: fileTargetDir, displayName });
    }

    if (clientRef.current?.ws && clientRef.current.ws.readyState === WebSocket.OPEN) {
      for (const dir of directories) {
        clientRef.current.ws.send(JSON.stringify({ action: "create_dir", path: dir }));
      }
    }

    for (let i = 0; i < filesWithTargets.length; i++) {
      const { file, targetDir, displayName } = filesWithTargets[i];
      const taskId = `ul_${Date.now()}_${i}`;
      const newTask: TransferTaskItem = {
        id: taskId,
        name: displayName,
        size: file.size,
        direction: "upload",
        sourcePath: displayName,
        targetPath: targetDir || "远程根目录",
        progress: 0,
        speed: 0,
        status: "transferring",
      };
      setTransferTasks(prev => [newTask, ...prev]);
      try {
        await clientRef.current.sendFile(file, targetDir, { overwrite },
          (progress: number, speed: number, status: string) => {
            setTransferTasks(prev => prev.map(t => t.id === taskId ?
              { ...t, progress, speed, status: status === "completed" ? "completed" : "transferring" } : t));
          });
        loadRemoteDir(remotePathRef.current);
      } catch (err: any) {
        setTransferTasks(prev => prev.map(t => t.id === taskId ?
          { ...t, status: "failed", error: err?.message || "上传失败" } : t));
      }
    }
  };

  const startDownload = async () => {
    if (!clientRef.current || selectedRemote.size === 0) return;
    for (const name of selectedRemote) {
      const entry = remoteEntries.find(e => e.name === name);
      if (!entry || entry.is_dir || entry.type === "disk") continue;
      const fullPath = remotePath ? `${remotePath}\\${name}` : name;
      const taskId = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const newTask: TransferTaskItem = {
        id: taskId,
        name,
        size: entry.size,
        direction: "download",
        sourcePath: fullPath,
        targetPath: "下载目录",
        progress: 0,
        speed: 0,
        status: "transferring",
      };
      setTransferTasks(prev => [newTask, ...prev]);
      try {
        await clientRef.current.downloadFile(fullPath, (progress: number, speed: number, status: string) => {
          setTransferTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress, speed, status: status as any } : t));
        });
      } catch (err: any) {
        setTransferTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: "failed", error: err?.message || "下载失败" } : t));
      }
    }
  };

  const handleDownloadSelected = async () => {
    if (!clientRef.current || selectedRemote.size === 0) return;
    startDownload();
  };

  const handleDoubleClickDownload = (name: string) => {
    setSelectedRemote(new Set([name]));
    startDownload();
  };

  const handleToggleSelectRemote = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedRemote(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    setPendingUploads(prev => {
      const existing = new Set(prev.map(f => `${f.name}_${f.size}`));
      const newFiles = fileArr.filter(f => !existing.has(`${f.name}_${f.size}`));
      const result = [...prev, ...newFiles];
      pendingUploadFilesRef.current = result;
      return result;
    });
    const currentRemotePath = remotePathRef.current || "";
    setConfirmTargetInput(currentRemotePath);
    setConfirmOverwrite("skip");
    const allFiles = [...pendingUploads, ...fileArr].filter((f, i, arr) => 
      arr.findIndex(x => x.name === f.name && x.size === f.size) === i
    );
    pendingUploadFilesRef.current = allFiles;
    setConfirmDialog({ mode: "upload", files: allFiles, targetPath: currentRemotePath, overwriteStrategy: "skip" });
  };

  const handleRemoveConfirmFile = (index: number) => {
    if (!confirmDialog) return;
    const fileToRemove = confirmDialog.files[index] as any;
    const newFiles = confirmDialog.files.filter((_, i) => i !== index);
    if (confirmDialog.mode === "upload") {
      pendingUploadFilesRef.current = pendingUploadFilesRef.current.filter(
        (f) => !(f.name === fileToRemove.name && f.size === fileToRemove.size)
      );
      setPendingUploads(pendingUploadFilesRef.current);
    }
    if (newFiles.length === 0) {
      setConfirmDialog(null);
    } else {
      setConfirmDialog({ ...confirmDialog, files: newFiles });
    }
  };

  const handleClearCompleted = () => {
    setTransferTasks(prev => prev.filter(t => t.status !== "completed"));
  };

  const handleCancelAll = () => {
    clientRef.current?.cancelTransfer();
    setTransferTasks(prev => prev.map(t =>
      t.status === "transferring" || t.status === "pending" ? { ...t, status: "failed", error: "已取消" } : t
    ));
  };

  const handlePauseAll = () => {
    clientRef.current?.pauseTransfer();
    setTransferTasks(prev => prev.map(t =>
      t.status === "transferring" ? { ...t, status: "paused" } : t
    ));
  };

  const handleStartAll = () => {
    clientRef.current?.resumeTransfer();
    setTransferTasks(prev => prev.map(t =>
      t.status === "paused" || t.status === "failed" ? { ...t, status: "transferring", progress: 0 } : t
    ));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center p-4"
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounterRef.current++;
        if (e.dataTransfer?.items && [...e.dataTransfer.items].some(i => i.kind === 'file')) {
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
          e.dataTransfer.effectAllowed = 'copy';
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={async (e) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setDragOver(false);
        console.log("[FileManager] onDrop triggered, items:", e.dataTransfer?.items?.length || 0);
        if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
          const files = await collectDraggedFiles(e.dataTransfer.items);
          if (files.length > 0) {
            handleFileSelect(files);
          }
        } else if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          handleFileSelect(e.dataTransfer.files);
        }
      }}
    >
      <div className="bg-card w-full max-w-6xl h-[85vh] rounded-lg shadow-2xl flex flex-col overflow-hidden border border-border relative">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-border">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Folder className="w-4 h-4 text-primary" />
            <span>文件管理器 — {deviceName}</span>
          </div>
          <div className="flex items-center gap-1">
            {onMinimize && (
              <button onClick={onMinimize} className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground" title="最小化（后台继续传输）">
                <Minus className="w-4 h-4" />
              </button>
            )}
            <button onClick={onClose} className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground" title="关闭">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Device headers */}
        <div className="flex items-stretch border-b border-border">
          <div className="flex-1 flex items-center gap-3 px-4 py-2.5 bg-card">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-foreground">待上传文件</h3>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-end gap-3 px-4 py-2.5 bg-card">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: 'var(--ur-state-success)' }}>远端</span>
              <h3 className="text-lg font-bold text-foreground">{deviceName || "远程设备"}</h3>
            </div>
          </div>
        </div>

        {/* Main content: dual panes */}
        <div className="flex-1 flex min-h-0">
          {/* Left: Pending Uploads */}
          <div className="flex-1 flex flex-col border-r border-border min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-card border-b border-border">
              <div className="flex-1" />
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files) handleFileSelect(e.target.files); }} />
              <input ref={folderInputRef} type="file" className="hidden"
                {...{ webkitdirectory: "", directory: "" } as any}
                onChange={(e) => { if (e.target.files) handleFileSelect(e.target.files); }} />
              <button onClick={() => fileInputRef.current?.click()}
                className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="选择文件">
                <Upload className="w-4 h-4" />
              </button>
              <button onClick={() => folderInputRef.current?.click()}
                className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="选择文件夹（保留目录层级）">
                <FolderPlus className="w-4 h-4" />
              </button>
              {pendingUploads.length > 0 && (
                <button onClick={() => { setPendingUploads([]); pendingUploadFilesRef.current = []; }}
                  className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="清空列表">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {pendingUploads.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 px-4">
                  <Upload className="w-12 h-12 text-muted-foreground opacity-50" />
                  <div className="text-muted-foreground text-sm text-center">拖拽文件到此窗口，或点击上方按钮选择文件</div>
                  <div className="text-muted-foreground text-xs text-center">浏览器出于安全限制无法直接访问本地文件系统</div>
                </div>
              ) : (
                <div className="flex flex-col">
                  {pendingUploads.map((file, idx) => {
                    const relDir = (((file as any)._relativePath || '') as string).replace(/[\\/]/g, '\\');
                    const webRel = (((file as any).webkitRelativePath || '') as string).replace(/[\\/]/g, '\\');
                    const shownName = relDir ? `${relDir}\\${file.name}` : (webRel || file.name);
                    return (
                    <div key={idx} className="flex items-center gap-2 px-3 py-2 border-b border-border hover:bg-muted">
                      <File className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate text-sm text-foreground min-w-0" title={shownName}>{shownName}</span>
                      <span className="text-xs text-muted-foreground shrink-0 font-mono">{fmtSize(file.size)}</span>
                      <button
                        onClick={() => {
                          setPendingUploads(prev => {
                            const next = prev.filter((_, i) => i !== idx);
                            pendingUploadFilesRef.current = next;
                            return next;
                          });
                        }}
                        className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-error shrink-0"
                        title="移除">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Remote */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-card border-b border-border">
              <button onClick={handleRemoteBack} className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="后退">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <button onClick={handleRemoteUp} className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="向上">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button onClick={() => loadRemoteDir(remotePath)} className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="刷新">
                <RefreshCw className={`w-4 h-4 ${remoteLoading ? "animate-spin" : ""}`} />
              </button>
              <div className="w-px h-4 bg-border mx-1"></div>
              <div className="flex-1 flex items-center gap-1 px-2 py-1 bg-muted rounded min-w-0">
                <Breadcrumb path={remotePath} onNavigate={loadRemoteDir} />
              </div>
              <div className="w-px h-4 bg-border mx-1"></div>
              <button onClick={handleDownloadSelected}
                disabled={selectedRemote.size === 0}
                className="p-1.5 hover:bg-muted rounded text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed" title="下载选中文件">
                <Download className="w-4 h-4" />
              </button>
              <button onClick={handleCreateRemoteFolder}
                className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="新建文件夹">
                <FolderPlus className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  for (const name of selectedRemote) {
                    handleRenameRemote(name);
                    break;
                  }
                }}
                disabled={selectedRemote.size !== 1}
                className="p-1.5 hover:bg-muted rounded text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed" title="重命名">
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  for (const name of selectedRemote) handleDeleteRemote(name);
                }}
                disabled={selectedRemote.size === 0}
                className="p-1.5 hover:bg-muted rounded text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed" title="删除">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 flex flex-col min-h-0">
              <FilePane
                entries={remoteEntries}
                selected={selectedRemote}
                onToggleSelect={handleToggleSelectRemote}
                isRemote={true}
                remoteLoading={remoteLoading}
                onNavigate={loadRemoteDir}
                remotePath={remotePath}
                onDownload={handleDoubleClickDownload}
                onContextMenu={(e, name, isDir) => {
                  setContextMenu({ x: e.clientX, y: e.clientY, targetName: name, isDir });
                }}
              />
            </div>
          </div>
        </div>

        {/* Transfer list */}
        <div className="border-t border-border bg-card flex flex-col" style={{ height: "180px" }}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card gap-3">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <span className="text-xs font-medium text-muted-foreground shrink-0">传输列表</span>
              {transferTasks.length > 0 && (
                <>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-xs">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${totalProgress.percent}%`, background: 'var(--ur-primary-600)' }} />
                  </div>
                  <span className="text-[11px] text-primary font-mono font-bold shrink-0">
                    {totalProgress.percent}% · {totalProgress.doneStr} / {totalProgress.totalStr}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={handlePauseAll} className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded">
                <Pause className="w-3 h-3" /> 全部暂停
              </button>
              <button onClick={handleStartAll} className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded">
                <Play className="w-3 h-3" /> 全部开始
              </button>
              <button onClick={handleCancelAll} className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded">
                <Ban className="w-3 h-3" /> 全部取消
              </button>
              <button onClick={handleClearCompleted} className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded">
                <Eraser className="w-3 h-3" /> 清除完结任务
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card border-b border-border">
                <tr className="text-muted-foreground">
                  <th className="py-1.5 px-3 text-left font-normal">名称</th>
                  <th className="py-1.5 px-3 text-left font-normal w-20">状态</th>
                  <th className="py-1.5 px-3 text-right font-normal w-24">大小</th>
                  <th className="py-1.5 px-3 text-left font-normal w-44">发送路径</th>
                  <th className="py-1.5 px-3 text-left font-normal w-44">接收路径</th>
                  <th className="py-1.5 px-3 text-center font-normal w-16">操作</th>
                </tr>
              </thead>
              <tbody>
                {transferTasks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-6 text-muted-foreground">暂无传输任务</td>
                  </tr>
                ) : (
                  transferTasks.map(task => {
                    const isFlashing = flashingTasks.has(task.id);
                    const showSpeed = task.status === "transferring" && task.speed > 0;
                    const showETA = task.status === "transferring" && task.speed > 0 && task.progress > 0;
                    const showProgressInName = task.status === "transferring" || task.status === "paused";
                    const showProgressBar = task.status !== "pending";
                    let eta = "";
                    if (showETA) {
                      const remainingBytes = task.size * (100 - task.progress) / 100;
                      const remainingSeconds = remainingBytes / (task.speed * 1024 * 1024);
                      eta = formatETA(remainingSeconds);
                    }
                    let rowFlashStyle: React.CSSProperties = {};
                    if (isFlashing) {
                      if (task.status === "completed") rowFlashStyle = { background: 'rgba(16,185,129,0.08)' };
                      else if (task.status === "failed") rowFlashStyle = { background: 'rgba(239,68,68,0.08)' };
                    }
                    return (
                      <tr key={task.id} className={`border-b border-border hover:bg-muted transition-colors duration-500`}
                        style={rowFlashStyle}>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center gap-2 min-w-0">
                            {task.direction === "upload" ? (
                              <Upload className="w-3.5 h-3.5 text-primary shrink-0" />
                            ) : (
                              <Download className="w-3.5 h-3.5 text-success shrink-0" />
                            )}
                            <span className="truncate text-foreground">{task.name}</span>
                            {showProgressInName && (
                              <span className="text-[10px] text-muted-foreground font-mono shrink-0">{task.progress}%</span>
                            )}
                            {showProgressBar && (
                              <div className="w-20 h-2 bg-muted rounded-full overflow-hidden shrink-0">
                                <div className={`h-full rounded-full ${getProgressColor(task.status)}`} style={{ width: `${task.progress}%` }} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="flex flex-col gap-0.5">
                            <div>
                              {task.status === "completed" && <span className="text-success">完成</span>}
                              {task.status === "transferring" && <span className="text-primary">传输中</span>}
                              {task.status === "failed" && <span className="text-error" title={task.error}>失败</span>}
                              {task.status === "paused" && <span className="text-warning">已暂停</span>}
                              {task.status === "pending" && <span className="text-muted-foreground">等待中</span>}
                            </div>
                            {(showSpeed || showETA) && (
                              <div className="flex gap-2 text-[10px] font-mono text-muted-foreground">
                                {showSpeed && <span>{task.speed.toFixed(2)} MB/s</span>}
                                {showETA && <span>· {eta}</span>}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-muted-foreground">{fmtSize(task.size)}</td>
                        <td className="py-1.5 px-3 text-muted-foreground truncate font-mono" title={task.sourcePath}>{task.sourcePath}</td>
                        <td className="py-1.5 px-3 text-muted-foreground truncate font-mono" title={task.targetPath}>{task.targetPath}</td>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center justify-center gap-0.5">
                            {task.status === "transferring" && (
                              <button onClick={() => handlePauseTask(task.id)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground" title="暂停">
                                <Pause className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(task.status === "paused" || task.status === "failed") && (
                              <button onClick={() => handleResumeTask(task.id)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground" title="继续">
                                <Play className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(task.status === "transferring" || task.status === "pending" || task.status === "paused") && (
                              <button onClick={() => handleCancelTask(task.id)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-error" title="取消">
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        {contextMenu && (
          <div
            className="fixed z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {!contextMenu.isDir && (
              <button
                onClick={() => {
                  setSelectedRemote(new Set([contextMenu.targetName]));
                  setContextMenu(null);
                  setTimeout(handleDownloadSelected, 0);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted text-left">
                <Download className="w-3.5 h-3.5" /> 下载
              </button>
            )}
            <button
              onClick={() => {
                handleRenameRemote(contextMenu.targetName);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted text-left">
              <Pencil className="w-3.5 h-3.5" /> 重命名
            </button>
            <button
              onClick={() => {
                handleDeleteRemote(contextMenu.targetName);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-error hover:bg-muted text-left">
              <Trash2 className="w-3.5 h-3.5" /> 删除
            </button>
          </div>
        )}
        {confirmDialog && (
          <div className="fixed inset-0 z-[60] backdrop-blur-sm flex items-center justify-center p-4"
            style={{ background: 'rgba(10,14,26,0.7)' }}
            onClick={(e) => { if (e.target === e.currentTarget) setConfirmDialog(null); }}>
            <div className="bg-card w-full max-w-lg rounded-lg shadow-2xl flex flex-col overflow-hidden border border-border">
              <div className="flex items-center justify-between px-4 py-3 bg-card border-b border-border">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {confirmDialog.mode === "upload" ? (
                    <><Upload className="w-4 h-4 text-primary" /> 确认上传</>
                  ) : (
                    <><Download className="w-4 h-4 text-success" /> 确认下载</>
                  )}
                </div>
                <button onClick={() => setConfirmDialog(null)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
                <div>
                  <div className="text-xs text-muted-foreground mb-2">
                    共 {confirmDialog.files.length} 个{confirmDialog.mode === "upload" ? "文件" : "项"}，
                    总大小 {fmtSize(confirmDialog.files.reduce((sum: number, f: any) => sum + (f.size || 0), 0))}
                  </div>
                  <div className="border border-border rounded-md max-h-40 overflow-y-auto bg-muted">
                    {confirmDialog.files.map((f: any, i: number) => (
                      <div key={i} className="flex items-center justify-between px-3 py-1.5 border-b border-border last:border-b-0 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          {f.is_dir ? <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" /> : <File className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                          <span className="truncate text-foreground">{f.name}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-muted-foreground">{f.size !== undefined ? fmtSize(f.size) : "--"}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRemoveConfirmFile(i); }}
                            className="p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                            title="移除">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {confirmDialog.mode === "upload" ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">目标位置</label>
                      <div className="flex gap-2">
                        <input type="text" value={confirmTargetInput}
                          onChange={(e) => setConfirmTargetInput(e.target.value)}
                          className="flex-1 px-3 py-2.5 text-sm font-mono text-foreground border-2 border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-muted"
                          placeholder="例如：D:\Downloads" />
                        <button
                          onClick={() => {
                            setDirPickerPath(confirmTargetInput || "");
                            loadDirPicker(confirmTargetInput || "");
                            setDirPickerOpen(true);
                          }}
                          className="px-4 py-2.5 text-sm bg-card hover:bg-muted text-foreground border-2 border-border hover:border-muted-foreground rounded-md font-medium transition-colors whitespace-nowrap shadow-sm">
                          浏览...
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">同名文件处理</label>
                      <div className="flex gap-3">
                        {[
                          { val: "skip" as OverwriteStrategy, label: "跳过" },
                          { val: "overwrite" as OverwriteStrategy, label: "覆盖" },
                          { val: "rename" as OverwriteStrategy, label: "自动重命名" },
                        ].map(opt => (
                          <button key={opt.val}
                            onClick={() => setConfirmOverwrite(opt.val)}
                            className={`flex-1 px-3 py-2 text-sm rounded-md border-2 font-medium transition-colors ${
                              confirmOverwrite === opt.val
                                ? "bg-primary text-white border-primary shadow-sm"
                                : "bg-card text-foreground border-border hover:border-muted-foreground"
                            }`}>
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="border border-warning/20 rounded-md px-3 py-2.5" style={{ background: 'rgba(245,158,11,0.08)' }}>
                    <div className="flex items-start gap-2">
                      <Monitor className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                      <div className="text-xs text-warning">
                        文件将下载到浏览器的默认下载目录。您可以在浏览器设置中修改下载位置。
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-3 bg-card border-t border-border">
                <button onClick={() => setConfirmDialog(null)}
                  className="px-4 py-1.5 text-xs text-muted-foreground hover:bg-muted rounded-md transition-colors">
                  取消
                </button>
                <button onClick={() => {
                  if (confirmDialog.mode === "upload") {
                    startUpload(pendingUploadFilesRef.current, confirmTargetInput, confirmOverwrite);
                    setPendingUploads([]);
                    pendingUploadFilesRef.current = [];
                  } else {
                    startDownload();
                  }
                  setConfirmDialog(null);
                }}
                  className={`px-4 py-1.5 text-xs text-white rounded-md transition-colors ${
                    confirmDialog.mode === "upload" ? "bg-primary hover:opacity-90" : "bg-success hover:opacity-90"
                  }`}>
                  确认{confirmDialog.mode === "upload" ? "上传" : "下载"}
                </button>
              </div>
            </div>
          </div>
        )}
        {dirPickerOpen && (
          <div className="fixed inset-0 z-[70] backdrop-blur-sm flex items-center justify-center p-4"
            style={{ background: 'rgba(10,14,26,0.7)' }}
            onClick={(e) => { if (e.target === e.currentTarget) setDirPickerOpen(false); }}>
            <div className="bg-card w-full max-w-2xl rounded-lg shadow-2xl flex flex-col overflow-hidden border border-border">
              <div className="flex items-center justify-between px-4 py-3 bg-card border-b border-border">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Folder className="w-4 h-4 text-primary" />
                  选择目标文件夹
                </div>
                <button onClick={() => setDirPickerOpen(false)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-1 px-3 py-2 bg-card border-b border-border">
                <button onClick={handleDirPickerUp} className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="向上">
                  <ChevronUp className="w-4 h-4" />
                </button>
                <button onClick={() => loadDirPicker("")} className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="此电脑">
                  <HardDrive className="w-4 h-4" />
                </button>
                <div className="flex-1 flex items-center gap-1 px-2 py-1 bg-muted rounded min-w-0 ml-1">
                  <Breadcrumb path={dirPickerPath} onNavigate={loadDirPicker} />
                </div>
                <button
                  onClick={() => setDirPickerShowNewFolder(v => !v)}
                  className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="新建文件夹">
                  <FolderPlus className="w-4 h-4" />
                </button>
                <button onClick={() => loadDirPicker(dirPickerPath)} className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="刷新">
                  <RefreshCw className={`w-4 h-4 ${dirPickerLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
              {dirPickerShowNewFolder && (
                <div className="flex items-center gap-2 px-3 py-2 bg-card border-b border-border">
                  <input
                    autoFocus
                    type="text"
                    value={dirPickerNewFolderName}
                    onChange={(e) => setDirPickerNewFolderName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleDirPickerCreateFolder(); }}
                    placeholder="新文件夹名称（将创建于当前目录）"
                    className="flex-1 px-2 py-1.5 text-sm bg-muted border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button onClick={handleDirPickerCreateFolder}
                    className="px-3 py-1.5 text-sm text-white bg-primary hover:opacity-90 rounded-md transition-colors">
                    创建
                  </button>
                </div>
              )}
              {dirPickerError && (
                <div className="px-4 py-2 text-xs bg-red-50 border-b border-border" style={{ color: '#dc2626' }}>
                  ⚠ {dirPickerError}
                </div>
              )}
              <div className="flex-1 overflow-y-auto" style={{ maxHeight: "50vh" }}>
                {dirPickerLoading && dirPickerEntries.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">加载中...</div>
                ) : dirPickerEntries.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">此文件夹为空</div>
                ) : (
                  dirPickerEntries
                    .filter(e => e.is_dir || e.type === "disk")
                    .map((entry) => {
                      const isDisk = entry.type === "disk";
                      const selPath = isDisk ? entry.name : (dirPickerPath ? `${dirPickerPath}\\${entry.name}` : entry.name);
                      const isSel = dirPickerSelected === selPath;
                      const enterDir = () => {
                        if (isDisk) loadDirPicker(entry.name);
                        else loadDirPicker(dirPickerPath ? `${dirPickerPath}\\${entry.name}` : entry.name);
                      };
                      return (
                        <div key={entry.name}
                          className="flex items-center gap-2 px-4 py-2 cursor-pointer border-b border-border select-none"
                          style={{ background: isSel ? 'rgba(37,99,235,0.08)' : undefined, outline: isSel ? '1px solid rgba(37,99,235,0.5)' : undefined }}
                          onClick={() => setDirPickerSelected(selPath)}
                          onDoubleClick={(e) => { e.stopPropagation(); enterDir(); }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); enterDir(); } }}
                          title="单击选中，双击进入">
                          {isDisk ? (
                            entry.disk_type === "removable" ? <Usb className="w-4 h-4 text-emerald-500 shrink-0" /> :
                            entry.disk_type === "network" ? <Network className="w-4 h-4 text-blue-500 shrink-0" /> :
                            entry.disk_type === "cdrom" ? <Disc className="w-4 h-4 text-amber-500 shrink-0" /> :
                            <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                          ) : (
                            <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                          )}
                          <span className="text-sm text-foreground truncate">
                            {isDisk ? (entry.label || entry.name.replace("\\", "")) : entry.name}
                          </span>
                          {isDisk && <span className="text-xs text-muted-foreground shrink-0">({entry.name.replace("\\", "")})</span>}
                        </div>
                      );
                    })
                )}
              </div>
              <div className="flex items-center justify-between px-4 py-3 bg-card border-t border-border">
                <div className="text-xs text-muted-foreground font-mono truncate flex-1 mr-4">
                  当前选择：{dirPickerSelected || dirPickerPath || "此电脑"}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setDirPickerOpen(false)}
                    className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded-md transition-colors">
                    取消
                  </button>
                  <button
                    onClick={() => {
                      setConfirmTargetInput(dirPickerSelected || dirPickerPath);
                      setDirPickerOpen(false);
                    }}
                    className="px-4 py-2 text-sm text-white bg-primary hover:opacity-90 rounded-md transition-colors font-medium">
                    选择此文件夹
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {dragOver && (
          <div className="absolute inset-0 z-40 bg-primary/20 border-4 border-primary border-dashed flex items-center justify-center pointer-events-none rounded-lg">
            <div className="bg-card/90 px-8 py-4 rounded-lg shadow-lg">
              <div className="flex items-center gap-3">
                <Upload className="w-8 h-8 text-primary" />
                <span className="text-primary font-medium text-lg">释放以上传文件</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
