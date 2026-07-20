/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Code, Download, Folder, File, Server, Monitor, LayoutDashboard } from "lucide-react";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight text-slate-100 flex items-center gap-3">
            <Monitor className="w-10 h-10 text-emerald-500 drop-shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            展厅远程控制系统
          </h1>
          <p className="text-lg text-slate-400 max-w-2xl">
            全栈架构蓝图已成功生成到工作区。项目分为三个核心模块：Rust 被控端 (Agent)、Go 数据中转枢纽 (Server Hub) 和 HTML5 前端控制端 (Frontend Client)。
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <ModuleCard
            title="Rust 被控端 (Agent)"
            icon={<Code className="w-6 h-6 text-amber-500" />}
            path="/agent-rust"
            description="极致轻量（<5MB）被控端，使用 CRC32 哈希和 turbojpeg SIMD 进行纯 CPU 的 32x32 网格脏矩形差异对比与 JPEG 压缩。"
            files={["Cargo.toml", "src/main.rs", "src/capture.rs", "src/dirty_rect.rs", "src/encoder.rs"]}
          />
          <ModuleCard
            title="Go 服务端 (Hub)"
            icon={<Server className="w-6 h-6 text-blue-500" />}
            path="/server-go"
            description="高性能二进制 WebSocket 中转中心。对外暴露标准 REST API，并将裸流画面无缝分发给订阅的客户端。"
            files={["go.mod", "main.go", "hub/device.go", "hub/router.go"]}
          />
          <ModuleCard
            title="前端控制端 (Client)"
            icon={<LayoutDashboard className="w-6 h-6 text-emerald-500" />}
            path="/frontend-client"
            description="零依赖的独立 HTML5 Canvas 集成示例，能够直接解析接收的二进制 WebSocket 图像流，并向服务端回传鼠标控制坐标。"
            files={["index.html", "remote-client.js"]}
          />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-xl font-bold text-slate-100 mb-4 flex items-center gap-2">
            <Download className="w-5 h-5 text-slate-400" />
            使用说明
          </h2>
          <ol className="list-decimal list-inside space-y-3 text-slate-400 text-sm">
            <li>在 AI Studio 菜单中点击 <strong className="text-slate-100">Export to ZIP</strong> 或 <strong className="text-slate-100">Export to GitHub</strong> 下载整个工作区。</li>
            <li><strong>Go 服务端:</strong> 在 <code className="text-blue-400 font-mono text-xs">/server-go</code> 目录下执行 <code className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded font-mono text-emerald-400 text-xs">go run main.go</code>，它将在 <code className="text-slate-300 font-mono text-xs">:8080</code> 端口启动监听。</li>
            <li><strong>Rust 被控端:</strong> 在你需要控制的 Windows 电脑上的 <code className="text-amber-400 font-mono text-xs">/agent-rust</code> 目录下执行 <code className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded font-mono text-emerald-400 text-xs">cargo run --release</code>。</li>
            <li><strong>前端控制端:</strong> 使用任何现代浏览器直接打开 <code className="text-emerald-400 font-mono text-xs">/frontend-client/index.html</code> 即可查看远程桌面实时画面并进行控制。</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function ModuleCard({ title, icon, path, description, files }: { title: string, icon: React.ReactNode, path: string, description: string, files: string[] }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 hover:bg-slate-800/50 transition-colors rounded-xl p-6 flex flex-col h-full">
      <div className="flex items-center gap-3 mb-4">
        {icon}
        <h3 className="text-xl font-bold text-slate-100">{title}</h3>
      </div>
      <div className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold bg-slate-950 text-slate-400 px-2.5 py-1 rounded-md border border-slate-700 mb-4 w-fit uppercase tracking-widest">
        <Folder className="w-3.5 h-3.5" /> {path}
      </div>
      <p className="text-sm text-slate-400 mb-6 flex-grow">{description}</p>
      
      <div className="space-y-2 border-t border-slate-800 pt-4">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">生成的文件</div>
        {files.map((file) => (
          <div key={file} className="flex items-center gap-2 text-xs text-slate-300 font-mono">
            <File className="w-3.5 h-3.5 text-slate-500" />
            {file}
          </div>
        ))}
      </div>
    </div>
  );
}
