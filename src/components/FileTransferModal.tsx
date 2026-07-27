import React, { useState, useRef } from "react";
import { FolderUp, UploadCloud, FileText, CheckCircle2, AlertCircle, X, Folder, HardDrive, Check, Clock, RefreshCw } from "lucide-react";

export interface TransferTask {
  id: string;
  fileName: string;
  fileSize: number;
  targetDir: string;
  progress: number;
  speedMBs: number;
  status: "pending" | "transferring" | "completed" | "failed" | "skipped";
  error?: string;
  timestamp: string;
}

interface FileTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceName: string;
  targetDir: string;
  setTargetDir: (dir: string) => void;
  onSendFiles: (files: FileList | File[], dir: string, overwriteMode: string, applyToAll: boolean, directories?: string[]) => void;
  tasks: TransferTask[];
  onClearHistory: () => void;
  onRetryFile: (task: TransferTask) => void;
}

const PRESET_PATHS = [
  { label: "桌面", path: "C:\\Users\\Administrator\\Desktop", icon: Folder },
  { label: "下载目录", path: "C:\\Users\\Public\\Downloads", icon: FolderUp },
  { label: "C 盘根目录", path: "C:\\", icon: HardDrive },
  { label: "D 盘根目录", path: "D:\\", icon: HardDrive },
];

// 递归遍历拖拽的文件夹，提取所有文件（保留相对路径）
async function traverseFileTree(items: DataTransferItemList, relativePath: string, result: File[]): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      const file = item.getAsFile();
      if (file) {
        // 将相对路径注入到 file 对象上
        (file as any)._relativePath = relativePath;
        result.push(file);
      }
      continue;
    }
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
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        dirReader.readEntries(resolve);
      });
      const subPath = relativePath ? `${relativePath}\\${entry.name}` : entry.name;
      for (const subEntry of entries) {
        await traverseEntry(subEntry, subPath, result);
      }
    }
  }
}

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
    // readEntries 可能分多批返回（每批最多 100 条），需要循环读取
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

export const FileTransferModal: React.FC<FileTransferModalProps> = ({
  isOpen,
  onClose,
  deviceName,
  targetDir,
  setTargetDir,
  onSendFiles,
  tasks,
  onClearHistory,
  onRetryFile,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [overwriteMode, setOverwriteMode] = useState("skip");
  const [applyToAll, setApplyToAll] = useState(false);

  if (!isOpen) return null;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSendFiles(e.target.files, targetDir, overwriteMode, applyToAll);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const allFiles: File[] = [];
      await traverseFileTree(e.dataTransfer.items, "", allFiles);
      if (allFiles.length > 0) {
        // Collect unique directory paths from relative paths
        const dirSet = new Set<string>();
        for (const file of allFiles) {
          const relPath = (file as any)._relativePath;
          if (relPath) {
            dirSet.add(relPath);
          }
        }
        onSendFiles(allFiles, targetDir, overwriteMode, applyToAll, Array.from(dirSet));
      }
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const activeTask = tasks.find((t) => t.status === "transferring");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-xl">
              <FolderUp className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                远程文件传输
                <span className="text-xs font-medium px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                  {deviceName}
                </span>
              </h3>
              <p className="text-xs text-slate-400">支持拖拽投送与自定义保存路径，局域网高速传输</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5 flex-1 custom-scrollbar">
          {/* Target Directory Selection */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
              远程文件保存位置 (可自定义 Path)
            </label>
            <div className="flex items-center gap-2 mb-2.5">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="请输入远程保存目录，例如: C:\Users\Public\Downloads"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>

            {/* Quick Presets */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {PRESET_PATHS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = targetDir === preset.path;
                return (
                  <button
                    key={preset.label}
                    onClick={() => setTargetDir(preset.path)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                      isSelected
                        ? "bg-blue-600/20 border-blue-500/50 text-blue-300"
                        : "bg-slate-950/50 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span className="truncate">{preset.label}</span>
                    {isSelected && <Check className="w-3 h-3 text-blue-400 ml-auto shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Conflict Strategy */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-400">冲突策略:</label>
              <select
                value={overwriteMode}
                onChange={(e) => setOverwriteMode(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors"
              >
                <option value="skip">跳过</option>
                <option value="overwrite">覆盖</option>
                <option value="rename">重命名</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-blue-500/50"
              />
              全部应用
            </label>
          </div>

          {/* Drag & Drop Dropzone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-3 ${
              isDragging
                ? "border-blue-500 bg-blue-500/10 scale-[1.01]"
                : "border-slate-800 hover:border-blue-500/50 bg-slate-950/40 hover:bg-slate-950/80"
            }`}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              multiple
              className="hidden"
            />
            <div className="w-12 h-12 rounded-2xl bg-slate-800/80 border border-slate-700/50 flex items-center justify-center text-blue-400 shadow-inner">
              <UploadCloud className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-200">
                点击选择文件 或 将文件拖拽至此处
              </p>
              <p className="text-xs text-slate-400 mt-1">
                目标路径: <span className="text-blue-400 font-mono">{targetDir || "C:\\Users\\Public\\Downloads"}</span>
              </p>
            </div>
          </div>

          {/* Active / Recent Transfers */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                传输队列与历史 ({tasks.length})
              </h4>
              {tasks.length > 0 && (
                <button
                  onClick={onClearHistory}
                  className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
                >
                  清空历史记录
                </button>
              )}
            </div>

            {/* Overall Progress */}
            {tasks.length > 0 && (() => {
              const totalTasks = tasks.length;
              const doneCount = tasks.filter(t => t.status === "completed" || t.status === "failed" || t.status === "skipped").length;
              const transferringTask = tasks.find(t => t.status === "transferring");
              const remainingBytes = tasks.reduce((sum, t) => {
                if (t.status === "transferring") return sum + t.fileSize * (1 - t.progress / 100);
                if (t.status === "pending") return sum + t.fileSize;
                return sum;
              }, 0);
              const speedBps = transferringTask ? transferringTask.speedMBs * 1024 * 1024 : 0;
              const etaSeconds = speedBps > 0 ? remainingBytes / speedBps : 0;
              const formatETA = (sec: number): string => {
                if (sec < 1) return "< 1秒";
                if (sec < 60) return `${Math.round(sec)}秒`;
                const min = Math.floor(sec / 60);
                const s = Math.round(sec % 60);
                return s > 0 ? `${min}分${s}秒` : `${min}分`;
              };
              return (
                <div className="flex items-center gap-4 mb-3 text-xs">
                  <span className="text-slate-400">
                    <span className="text-blue-400 font-semibold">{doneCount}</span>
                    <span className="text-slate-500">/{totalTasks} 个文件</span>
                  </span>
                  {etaSeconds > 0 && (
                    <span className="text-slate-500">
                      预计剩余 <span className="text-amber-400 font-mono">{formatETA(etaSeconds)}</span>
                    </span>
                  )}
                </div>
              );
            })()}

            {tasks.length === 0 ? (
              <div className="py-8 text-center border border-slate-800/60 rounded-xl bg-slate-950/30 text-slate-500 text-xs">
                暂无传输任务，选择文件即可开始投送
              </div>
            ) : (
              <div className="space-y-2.5 max-h-52 overflow-y-auto pr-1 custom-scrollbar">
                {tasks.map((task) => {
                  const statusColors: Record<string, string> = {
                    transferring: "border-blue-500/30",
                    completed: "border-emerald-500/30",
                    failed: "border-rose-500/30",
                    skipped: "border-amber-500/30",
                    pending: "border-slate-700",
                  };
                  const statusBadgeColors: Record<string, string> = {
                    transferring: "text-blue-400 bg-blue-500/10 border-blue-500/20",
                    completed: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
                    failed: "text-rose-400 bg-rose-500/10 border-rose-500/20",
                    skipped: "text-amber-400 bg-amber-500/10 border-amber-500/20",
                    pending: "text-slate-400 bg-slate-800 border-slate-700",
                  };
                  const statusLabels: Record<string, string> = {
                    transferring: "传输中",
                    completed: "完成",
                    failed: "失败",
                    skipped: "已跳过",
                    pending: "等待中",
                  };
                  const progressBarColor: Record<string, string> = {
                    transferring: "bg-blue-500",
                    completed: "bg-emerald-500",
                    failed: "bg-rose-500",
                    skipped: "bg-amber-500",
                    pending: "bg-slate-600",
                  };
                  return (
                    <div
                      key={task.id}
                      className={`p-3 bg-slate-950/60 border rounded-xl flex flex-col gap-2 ${statusColors[task.status] || "border-slate-800/80"}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <FileText className={`w-4 h-4 shrink-0 ${
                            task.status === "transferring" ? "text-blue-400" :
                            task.status === "completed" ? "text-emerald-400" :
                            task.status === "failed" ? "text-rose-400" :
                            task.status === "skipped" ? "text-amber-400" :
                            "text-slate-500"
                          }`} />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-slate-200 truncate">{task.fileName}</p>
                            <p className="text-[10px] text-slate-400 truncate">
                              {formatSize(task.fileSize)} • 保存至 {task.targetDir}
                            </p>
                            {/* Error message for failed tasks */}
                            {task.status === "failed" && task.error && (
                              <p className="text-[10px] text-rose-400 mt-0.5">{task.error}</p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {task.status === "transferring" && (
                            <span className="text-[11px] font-mono font-semibold text-blue-400">
                              {task.speedMBs.toFixed(1)} MB/s
                            </span>
                          )}
                          <span className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${statusBadgeColors[task.status] || ""}`}>
                            {task.status === "completed" && <CheckCircle2 className="w-3 h-3" />}
                            {task.status === "failed" && <AlertCircle className="w-3 h-3" />}
                            {statusLabels[task.status] || task.status}
                          </span>
                          {/* Retry button for failed and skipped tasks */}
                          {(task.status === "failed" || task.status === "skipped") && (
                            <button
                              onClick={() => onRetryFile(task)}
                              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                              title="重试"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Progress Bar for transferring */}
                      {task.status === "transferring" && (
                        <div className="space-y-1">
                          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`${progressBarColor[task.status]} h-full transition-all duration-150 rounded-full`}
                              style={{ width: `${task.progress}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                            <span>传输中...</span>
                            <span>{task.progress}%</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-900/90 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>提示: 传输采用零内存缓冲流式分发</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-xl transition-colors"
          >
            关闭窗口
          </button>
        </div>
      </div>
    </div>
  );
};
