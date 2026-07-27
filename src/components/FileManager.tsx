import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Folder, File, ChevronUp, RefreshCw, FolderPlus, Trash2, X, Minus,
  ArrowLeft, HardDrive, ChevronDown,
  Upload, Download, Play, Pause, Ban, Eraser, Monitor,
  Usb, Network, Disc, Pencil,
  FileText, FileImage, FileVideo, FileAudio, FileCode, FileArchive,
  FileSpreadsheet, FileJson, FileQuestion,
} from "lucide-react";

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
}

type OverwriteStrategy = "skip" | "overwrite" | "rename";

interface ConfirmDialogState {
  mode: "upload" | "download";
  files: File[] | FileEntry[];
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
    case "transferring": return "bg-blue-500";
    case "completed": return "bg-emerald-500";
    case "failed": return "bg-red-500";
    case "paused": return "bg-amber-500";
    default: return "bg-slate-300";
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
  if (entry.type === "disk") return { Icon: HardDrive, color: "text-slate-500" };
  if (entry.is_dir) return { Icon: Folder, color: "text-amber-500" };
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";

  const imageExts = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif"];
  if (imageExts.includes(ext)) return { Icon: FileImage, color: "text-pink-500" };

  const videoExts = ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "3gp"];
  if (videoExts.includes(ext)) return { Icon: FileVideo, color: "text-purple-500" };

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

  return { Icon: FileQuestion, color: "text-slate-400" };
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
      <div className="flex items-center gap-2 text-xs text-slate-700">
        <HardDrive className="w-3.5 h-3.5" />
        <span>此电脑</span>
        <ChevronDown className="w-3 h-3" />
      </div>
    );
  }
  const parts = path.split("\\").filter(Boolean);
  return (
    <div className="flex items-center gap-1 overflow-x-auto text-xs">
      <button onClick={() => onNavigate("")} className="flex items-center gap-1 text-slate-600 hover:text-slate-800 shrink-0 px-1 py-0.5 rounded hover:bg-slate-200">
        <HardDrive className="w-3 h-3" /> 此电脑
      </button>
      <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
      {parts.map((part, idx) => {
        const fullPath = parts.slice(0, idx + 1).join("\\") + "\\";
        const isLast = idx === parts.length - 1;
        return (
          <React.Fragment key={idx}>
            <button onClick={() => onNavigate(fullPath)}
              className={`px-1 py-0.5 rounded shrink-0 ${isLast ? "bg-slate-200 text-slate-800 font-medium" : "text-slate-600 hover:text-slate-800 hover:bg-slate-200"}`}>
              {part}
            </button>
            {!isLast && <ChevronDown className="w-3 h-3 text-slate-400 shrink-0 -rotate-90" />}
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
        <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 z-10">
          <tr className="text-slate-500">
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
                  <span className="text-slate-400">{remoteLoading ? "加载中..." : "此文件夹为空"}</span>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <Upload className="w-10 h-10 text-slate-300" />
                    <div className="text-slate-400 text-sm">拖拽文件到此窗口，或点击右上角按钮选择文件</div>
                    <div className="text-slate-300 text-xs">浏览器出于安全限制无法直接访问本地文件系统</div>
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
                  className={`border-b border-slate-100 cursor-pointer hover:bg-blue-50 ${isSelected ? "bg-blue-100" : ""}`}
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
                          <HardDrive className="w-4 h-4 text-slate-500 shrink-0" />
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
                              <span className="truncate text-slate-800 font-medium">
                                {entry.label || entry.name.replace("\\", "")}
                              </span>
                              <span className="text-slate-400 text-xs shrink-0">
                                ({entry.name.replace("\\", "")})
                              </span>
                            </>
                          ) : (
                            <span className="truncate text-slate-800">{entry.name}</span>
                          )}
                        </div>
                        {isDisk && entry.size > 0 && (
                          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                            <div className="flex-1 h-1 bg-slate-200 rounded-full overflow-hidden min-w-[60px]">
                              <div
                                className={`h-full rounded-full ${
                                  (1 - (entry.free || 0) / entry.size) > 0.9
                                    ? "bg-red-500"
                                    : (1 - (entry.free || 0) / entry.size) > 0.75
                                    ? "bg-amber-500"
                                    : "bg-emerald-500"
                                }`}
                                style={{ width: `${Math.round((1 - (entry.free || 0) / entry.size) * 100)}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-slate-500 shrink-0 font-mono whitespace-nowrap">
                              可用 {fmtSize(entry.free || 0)} / {fmtSize(entry.size)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-1 px-1.5 text-slate-600">{fmtDate(entry.modified)}</td>
                  <td className="py-1 px-1.5 text-slate-600">{getFileType(entry)}</td>
                  <td className="py-1 px-1.5 text-slate-600 text-right font-mono">
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

  const remotePathRef = useRef(remotePath);
  useEffect(() => { remotePathRef.current = remotePath; }, [remotePath]);
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
    setDirPickerPath(path);
    const msg = JSON.stringify({ action: "list_dir", path });
    clientRef.current.ws.send(msg);
    if (dirPickerTimeoutRef.current) clearTimeout(dirPickerTimeoutRef.current);
    dirPickerTimeoutRef.current = setTimeout(() => {
      setDirPickerLoading(false);
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

  const handleCreateRemoteFolder = () => {
    const name = window.prompt("请输入文件夹名称：");
    if (!name || !clientRef.current?.ws) return;
    const fullPath = remotePath ? `${remotePath}\\${name}` : name;
    clientRef.current.ws.send(JSON.stringify({ action: "create_dir", path: fullPath }));
    setTimeout(() => loadRemoteDir(remotePath), 500);
  };

  const handleDeleteRemote = async (name: string) => {
    if (!clientRef.current?.ws) return;
    const fullPath = remotePath ? `${remotePath}\\${name}` : name;
    if (!window.confirm(`确认删除 ${name}?`)) return;
    clientRef.current.ws.send(JSON.stringify({ action: "delete_file", path: fullPath }));
  };

  const handleRenameRemote = (oldName: string) => {
    const newName = window.prompt("请输入新名称：", oldName);
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
    const directories = new Set<string>();
    const filesWithTargets: { file: File; targetDir: string; displayName: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relPath = (file as any).webkitRelativePath || (file as any)._relativePath || '';
      let fileTargetDir = targetPath;
      let displayName = file.name;

      if (relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        parts.pop();
        const subDir = parts.join('\\');
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
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4"
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
      <div className="bg-white w-full max-w-6xl h-[85vh] rounded-lg shadow-2xl flex flex-col overflow-hidden border border-slate-200 relative">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <Folder className="w-4 h-4 text-indigo-500" />
            <span>文件管理器 — {deviceName}</span>
          </div>
          <div className="flex items-center gap-1">
            {onMinimize && (
              <button onClick={onMinimize} className="p-1.5 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700" title="最小化（后台继续传输）">
                <Minus className="w-4 h-4" />
              </button>
            )}
            <button onClick={onClose} className="p-1.5 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700" title="关闭">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Device headers */}
        <div className="flex items-stretch border-b border-slate-200">
          <div className="flex-1 flex items-center gap-3 px-4 py-2.5 bg-white">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-slate-800">待上传文件</h3>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-end gap-3 px-4 py-2.5 bg-white">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-medium">远端</span>
              <h3 className="text-lg font-bold text-slate-800">{deviceName || "远程设备"}</h3>
            </div>
          </div>
        </div>

        {/* Main content: dual panes */}
        <div className="flex-1 flex min-h-0">
          {/* Left: Pending Uploads */}
          <div className="flex-1 flex flex-col border-r border-slate-200 min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-white border-b border-slate-200">
              <div className="flex-1" />
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files) handleFileSelect(e.target.files); }} />
              <input ref={folderInputRef} type="file" className="hidden"
                {...{ webkitdirectory: "", directory: "" } as any}
                onChange={(e) => { if (e.target.files) handleFileSelect(e.target.files); }} />
              <button onClick={() => fileInputRef.current?.click()}
                className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="选择文件">
                <Upload className="w-4 h-4" />
              </button>
              {pendingUploads.length > 0 && (
                <button onClick={() => { setPendingUploads([]); pendingUploadFilesRef.current = []; }}
                  className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="清空列表">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {pendingUploads.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 px-4">
                  <Upload className="w-12 h-12 text-slate-300" />
                  <div className="text-slate-500 text-sm text-center">拖拽文件到此窗口，或点击上方按钮选择文件</div>
                  <div className="text-slate-300 text-xs text-center">浏览器出于安全限制无法直接访问本地文件系统</div>
                </div>
              ) : (
                <div className="flex flex-col">
                  {pendingUploads.map((file, idx) => (
                    <div key={idx} className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 hover:bg-slate-50">
                      <File className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="flex-1 truncate text-sm text-slate-700 min-w-0">{file.name}</span>
                      <span className="text-xs text-slate-400 shrink-0 font-mono">{fmtSize(file.size)}</span>
                      <button
                        onClick={() => {
                          setPendingUploads(prev => {
                            const next = prev.filter((_, i) => i !== idx);
                            pendingUploadFilesRef.current = next;
                            return next;
                          });
                        }}
                        className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 shrink-0"
                        title="移除">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: Remote */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-white border-b border-slate-200">
              <button onClick={handleRemoteBack} className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="后退">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <button onClick={handleRemoteUp} className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="向上">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button onClick={() => loadRemoteDir(remotePath)} className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="刷新">
                <RefreshCw className={`w-4 h-4 ${remoteLoading ? "animate-spin" : ""}`} />
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1"></div>
              <div className="flex-1 flex items-center gap-1 px-2 py-1 bg-slate-100 rounded min-w-0">
                <Breadcrumb path={remotePath} onNavigate={loadRemoteDir} />
              </div>
              <div className="w-px h-4 bg-slate-200 mx-1"></div>
              <button onClick={handleDownloadSelected}
                disabled={selectedRemote.size === 0}
                className="p-1.5 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed" title="下载选中文件">
                <Download className="w-4 h-4" />
              </button>
              <button onClick={handleCreateRemoteFolder}
                className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="新建文件夹">
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
                className="p-1.5 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed" title="重命名">
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  for (const name of selectedRemote) handleDeleteRemote(name);
                }}
                disabled={selectedRemote.size === 0}
                className="p-1.5 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-40 disabled:cursor-not-allowed" title="删除">
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
        <div className="border-t border-slate-200 bg-slate-50 flex flex-col" style={{ height: "180px" }}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white gap-3">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <span className="text-xs font-medium text-slate-600 shrink-0">传输列表</span>
              {transferTasks.length > 0 && (
                <>
                  <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden max-w-xs">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all"
                      style={{ width: `${totalProgress.percent}%` }} />
                  </div>
                  <span className="text-[11px] text-indigo-600 font-mono font-bold shrink-0">
                    {totalProgress.percent}% · {totalProgress.doneStr} / {totalProgress.totalStr}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={handlePauseAll} className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded">
                <Pause className="w-3 h-3" /> 全部暂停
              </button>
              <button onClick={handleStartAll} className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded">
                <Play className="w-3 h-3" /> 全部开始
              </button>
              <button onClick={handleCancelAll} className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded">
                <Ban className="w-3 h-3" /> 全部取消
              </button>
              <button onClick={handleClearCompleted} className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded">
                <Eraser className="w-3 h-3" /> 清除完结任务
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-100 border-b border-slate-200">
                <tr className="text-slate-500">
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
                    <td colSpan={6} className="text-center py-6 text-slate-400">暂无传输任务</td>
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
                    let rowFlashClass = "";
                    if (isFlashing) {
                      if (task.status === "completed") rowFlashClass = "bg-emerald-50";
                      else if (task.status === "failed") rowFlashClass = "bg-red-50";
                    }
                    return (
                      <tr key={task.id} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors duration-500 ${rowFlashClass}`}>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center gap-2 min-w-0">
                            {task.direction === "upload" ? (
                              <Upload className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                            ) : (
                              <Download className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            )}
                            <span className="truncate text-slate-700">{task.name}</span>
                            {showProgressInName && (
                              <span className="text-[10px] text-slate-500 font-mono shrink-0">{task.progress}%</span>
                            )}
                            {showProgressBar && (
                              <div className="w-20 h-2 bg-slate-200 rounded-full overflow-hidden shrink-0">
                                <div className={`h-full rounded-full ${getProgressColor(task.status)}`} style={{ width: `${task.progress}%` }} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="flex flex-col gap-0.5">
                            <div>
                              {task.status === "completed" && <span className="text-emerald-600">完成</span>}
                              {task.status === "transferring" && <span className="text-blue-600">传输中</span>}
                              {task.status === "failed" && <span className="text-red-500" title={task.error}>失败</span>}
                              {task.status === "paused" && <span className="text-amber-600">已暂停</span>}
                              {task.status === "pending" && <span className="text-slate-500">等待中</span>}
                            </div>
                            {(showSpeed || showETA) && (
                              <div className="flex gap-2 text-[10px] font-mono text-slate-500">
                                {showSpeed && <span>{task.speed.toFixed(2)} MB/s</span>}
                                {showETA && <span>· {eta}</span>}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-600">{fmtSize(task.size)}</td>
                        <td className="py-1.5 px-3 text-slate-600 truncate font-mono" title={task.sourcePath}>{task.sourcePath}</td>
                        <td className="py-1.5 px-3 text-slate-600 truncate font-mono" title={task.targetPath}>{task.targetPath}</td>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center justify-center gap-0.5">
                            {task.status === "transferring" && (
                              <button onClick={() => handlePauseTask(task.id)} className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700" title="暂停">
                                <Pause className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(task.status === "paused" || task.status === "failed") && (
                              <button onClick={() => handleResumeTask(task.id)} className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700" title="继续">
                                <Play className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(task.status === "transferring" || task.status === "pending" || task.status === "paused") && (
                              <button onClick={() => handleCancelTask(task.id)} className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-red-600" title="取消">
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
            className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[140px]"
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
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 text-left">
                <Download className="w-3.5 h-3.5" /> 下载
              </button>
            )}
            <button
              onClick={() => {
                handleRenameRemote(contextMenu.targetName);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 text-left">
              <Pencil className="w-3.5 h-3.5" /> 重命名
            </button>
            <button
              onClick={() => {
                handleDeleteRemote(contextMenu.targetName);
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 text-left">
              <Trash2 className="w-3.5 h-3.5" /> 删除
            </button>
          </div>
        )}
        {confirmDialog && (
          <div className="fixed inset-0 z-[60] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setConfirmDialog(null); }}>
            <div className="bg-white w-full max-w-lg rounded-lg shadow-2xl flex flex-col overflow-hidden border border-slate-200">
              <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  {confirmDialog.mode === "upload" ? (
                    <><Upload className="w-4 h-4 text-blue-500" /> 确认上传</>
                  ) : (
                    <><Download className="w-4 h-4 text-emerald-500" /> 确认下载</>
                  )}
                </div>
                <button onClick={() => setConfirmDialog(null)} className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
                <div>
                  <div className="text-xs text-slate-500 mb-2">
                    共 {confirmDialog.files.length} 个{confirmDialog.mode === "upload" ? "文件" : "项"}，
                    总大小 {fmtSize(confirmDialog.files.reduce((sum: number, f: any) => sum + (f.size || 0), 0))}
                  </div>
                  <div className="border border-slate-200 rounded-md max-h-40 overflow-y-auto bg-slate-50">
                    {confirmDialog.files.map((f: any, i: number) => (
                      <div key={i} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 last:border-b-0 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          {f.is_dir ? <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" /> : <File className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                          <span className="truncate text-slate-700">{f.name}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-slate-500">{f.size !== undefined ? fmtSize(f.size) : "--"}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRemoveConfirmFile(i); }}
                            className="p-0.5 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600"
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
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">目标位置</label>
                      <div className="flex gap-2">
                        <input type="text" value={confirmTargetInput}
                          onChange={(e) => setConfirmTargetInput(e.target.value)}
                          className="flex-1 px-3 py-2.5 text-sm font-mono text-slate-800 border-2 border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 bg-slate-50"
                          placeholder="例如：D:\Downloads" />
                        <button
                          onClick={() => {
                            setDirPickerPath(confirmTargetInput || "");
                            loadDirPicker(confirmTargetInput || "");
                            setDirPickerOpen(true);
                          }}
                          className="px-4 py-2.5 text-sm bg-white hover:bg-slate-50 text-slate-700 border-2 border-slate-300 hover:border-slate-400 rounded-md font-medium transition-colors whitespace-nowrap shadow-sm">
                          浏览...
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">同名文件处理</label>
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
                                ? "bg-blue-500 text-white border-blue-500 shadow-sm"
                                : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"
                            }`}>
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <Monitor className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="text-xs text-amber-800">
                        文件将下载到浏览器的默认下载目录。您可以在浏览器设置中修改下载位置。
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-3 bg-slate-50 border-t border-slate-200">
                <button onClick={() => setConfirmDialog(null)}
                  className="px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded-md transition-colors">
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
                    confirmDialog.mode === "upload" ? "bg-blue-500 hover:bg-blue-600" : "bg-emerald-500 hover:bg-emerald-600"
                  }`}>
                  确认{confirmDialog.mode === "upload" ? "上传" : "下载"}
                </button>
              </div>
            </div>
          </div>
        )}
        {dirPickerOpen && (
          <div className="fixed inset-0 z-[70] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setDirPickerOpen(false); }}>
            <div className="bg-white w-full max-w-2xl rounded-lg shadow-2xl flex flex-col overflow-hidden border border-slate-200">
              <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <Folder className="w-4 h-4 text-blue-500" />
                  选择目标文件夹
                </div>
                <button onClick={() => setDirPickerOpen(false)} className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-1 px-3 py-2 bg-white border-b border-slate-200">
                <button onClick={handleDirPickerUp} className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="向上">
                  <ChevronUp className="w-4 h-4" />
                </button>
                <button onClick={() => loadDirPicker("")} className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="此电脑">
                  <HardDrive className="w-4 h-4" />
                </button>
                <div className="flex-1 flex items-center gap-1 px-2 py-1 bg-slate-100 rounded min-w-0 ml-1">
                  <Breadcrumb path={dirPickerPath} onNavigate={loadDirPicker} />
                </div>
                <button onClick={() => loadDirPicker(dirPickerPath)} className="p-1.5 hover:bg-slate-100 rounded text-slate-500" title="刷新">
                  <RefreshCw className={`w-4 h-4 ${dirPickerLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto" style={{ maxHeight: "50vh" }}>
                {dirPickerLoading && dirPickerEntries.length === 0 ? (
                  <div className="text-center py-12 text-slate-400">加载中...</div>
                ) : dirPickerEntries.length === 0 ? (
                  <div className="text-center py-12 text-slate-400">此文件夹为空</div>
                ) : (
                  dirPickerEntries
                    .filter(e => e.is_dir || e.type === "disk")
                    .map((entry) => {
                      const isDisk = entry.type === "disk";
                      return (
                        <div key={entry.name}
                          className="flex items-center gap-2 px-4 py-2 hover:bg-blue-50 cursor-pointer border-b border-slate-100"
                          onClick={() => {
                            if (isDisk) {
                              loadDirPicker(entry.name);
                            } else {
                              loadDirPicker(dirPickerPath ? `${dirPickerPath}\\${entry.name}` : entry.name);
                            }
                          }}
                          onDoubleClick={() => {
                            const target = isDisk ? entry.name : (dirPickerPath ? `${dirPickerPath}\\${entry.name}` : entry.name);
                            setConfirmTargetInput(target);
                            setDirPickerOpen(false);
                          }}>
                          {isDisk ? (
                            entry.disk_type === "removable" ? <Usb className="w-4 h-4 text-emerald-500 shrink-0" /> :
                            entry.disk_type === "network" ? <Network className="w-4 h-4 text-blue-500 shrink-0" /> :
                            entry.disk_type === "cdrom" ? <Disc className="w-4 h-4 text-amber-500 shrink-0" /> :
                            <HardDrive className="w-4 h-4 text-slate-500 shrink-0" />
                          ) : (
                            <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                          )}
                          <span className="text-sm text-slate-700 truncate">
                            {isDisk ? (entry.label || entry.name.replace("\\", "")) : entry.name}
                          </span>
                          {isDisk && <span className="text-xs text-slate-400 shrink-0">({entry.name.replace("\\", "")})</span>}
                        </div>
                      );
                    })
                )}
              </div>
              <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-t border-slate-200">
                <div className="text-xs text-slate-500 font-mono truncate flex-1 mr-4">
                  当前路径：{dirPickerPath || "此电脑"}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setDirPickerOpen(false)}
                    className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-200 rounded-md transition-colors">
                    取消
                  </button>
                  <button
                    onClick={() => {
                      setConfirmTargetInput(dirPickerPath);
                      setDirPickerOpen(false);
                    }}
                    className="px-4 py-2 text-sm text-white bg-blue-500 hover:bg-blue-600 rounded-md transition-colors font-medium">
                    选择此文件夹
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {dragOver && (
          <div className="absolute inset-0 z-40 bg-blue-500/20 border-4 border-blue-500 border-dashed flex items-center justify-center pointer-events-none rounded-lg">
            <div className="bg-white/90 px-8 py-4 rounded-lg shadow-lg">
              <div className="flex items-center gap-3">
                <Upload className="w-8 h-8 text-blue-500" />
                <span className="text-blue-700 font-medium text-lg">释放以上传文件</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
