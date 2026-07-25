import React, { useState, useRef } from "react";
import { FolderUp, UploadCloud, FileText, CheckCircle2, AlertCircle, X, Folder, HardDrive, Check, Clock, ArrowRight } from "lucide-react";

export interface TransferTask {
  id: string;
  fileName: string;
  fileSize: number;
  targetDir: string;
  progress: number;
  speedMBs: number;
  status: "pending" | "transferring" | "completed" | "failed";
  error?: string;
  timestamp: string;
}

interface FileTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceName: string;
  targetDir: string;
  setTargetDir: (dir: string) => void;
  onSendFiles: (files: FileList | File[], dir: string) => void;
  tasks: TransferTask[];
  onClearHistory: () => void;
}

const PRESET_PATHS = [
  { label: "桌面", path: "C:\\Users\\Administrator\\Desktop", icon: Folder },
  { label: "下载目录", path: "C:\\Users\\Public\\Downloads", icon: FolderUp },
  { label: "C 盘根目录", path: "C:\\", icon: HardDrive },
  { label: "D 盘根目录", path: "D:\\", icon: HardDrive },
];

export const FileTransferModal: React.FC<FileTransferModalProps> = ({
  isOpen,
  onClose,
  deviceName,
  targetDir,
  setTargetDir,
  onSendFiles,
  tasks,
  onClearHistory,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSendFiles(e.target.files, targetDir);
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onSendFiles(e.dataTransfer.files, targetDir);
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

            {tasks.length === 0 ? (
              <div className="py-8 text-center border border-slate-800/60 rounded-xl bg-slate-950/30 text-slate-500 text-xs">
                暂无传输任务，选择文件即可开始投送
              </div>
            ) : (
              <div className="space-y-2.5 max-h-52 overflow-y-auto pr-1 custom-scrollbar">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-200 truncate">{task.fileName}</p>
                          <p className="text-[10px] text-slate-400 truncate">
                            {formatSize(task.fileSize)} • 保存至 {task.targetDir}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {task.status === "transferring" && (
                          <span className="text-[11px] font-mono font-semibold text-blue-400">
                            {task.speedMBs.toFixed(1)} MB/s
                          </span>
                        )}
                        {task.status === "completed" && (
                          <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-3 h-3" /> 已完成
                          </span>
                        )}
                        {task.status === "failed" && (
                          <span className="flex items-center gap-1 text-[10px] text-rose-400 font-medium bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-full">
                            <AlertCircle className="w-3 h-3" /> 失败
                          </span>
                        )}
                        {task.status === "pending" && (
                          <span className="text-[10px] text-slate-400 bg-slate-800 px-2 py-0.5 rounded-full">
                            等待中
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar for transferring or pending */}
                    {task.status === "transferring" && (
                      <div className="space-y-1">
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="bg-blue-500 h-full transition-all duration-150 rounded-full"
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
                ))}
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
