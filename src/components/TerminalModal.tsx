import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X, Terminal as TerminalIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

// 与后端 Agent/Hub 协议约定的固定会话 id
const SESSION_ID = 1;

interface TerminalModalProps {
  serverUrl: string;
  deviceId: string;
  deviceName?: string;
  onClose: () => void;
}

export const TerminalModal: React.FC<TerminalModalProps> = ({ serverUrl, deviceId, deviceName, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const closedRef = useRef(false);
  // 本地行缓冲 + 命令历史：cmd 管道模式不做行编辑，前端负责模拟"原始 cmd 编辑体验"
  const lineRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    openedRef.current = false;
    closedRef.current = false;

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#1e1e1e", foreground: "#e0e0e0" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    try { fitAddon.fit(); } catch { /* 容器尺寸异常时忽略 */ }
    // 打开即聚焦：否则用户直接输入时按键不进入 xterm，表现为"输入无反应"
    term.focus();

    // 复制/粘贴：放行给浏览器 + xterm 原生事件链处理（Ctrl+C 复制、Ctrl+V 粘贴，
    // 与已验证有效的 Ctrl+Shift+C/V 走完全相同的路径）。xterm 默认把 Ctrl+C/V
    // 当作控制字符拦截并取消浏览器默认动作，这里 return false 跳过 xterm 的映射与
    // cancel，让浏览器默认动作执行 → xterm 原生 paste/copy 处理 → onData 一次。
    // 项目内无其他 paste 监听，天然单一路径，不可能双重粘贴。
    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "v")) {
        return false;
      }
      return true;
    });

    const send = (payload: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    const ws = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/api/v1/terminal?device_id=${deviceId}`);

    ws.onopen = () => {
      openedRef.current = true;
      send({ action: "terminal_open", id: SESSION_ID, rows: term.rows, cols: term.cols });
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "terminal_output") {
        term.write(msg.data);
      } else if (msg.type === "terminal_closed") {
        closedRef.current = true;
        term.write(`\r\n\x1b[90m[会话已关闭] exit_code=${msg.exit_code ?? "?"}\x1b[0m\r\n`);
      }
      // 其他类型（terminal_opened 等）忽略
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m[连接错误] 无法建立终端 WebSocket 连接\x1b[0m\r\n");
    };

    ws.onclose = () => {
      // 主动关闭（组件卸载）时不提示；异常断开（如 Hub 超时/重启）时告知用户
      if (closedRef.current) return;
      closedRef.current = true;
      term.write("\r\n\x1b[33m[连接已断开] 终端会话结束，请关闭后重新打开\x1b[0m\r\n");
    };

    // 用完整命令替换当前行显示（先逐个 \b \b 清空，再写新内容）
    const replaceLine = (text: string) => {
      for (let i = 0; i < lineRef.current.length; i++) term.write("\b \b");
      lineRef.current = text;
      term.write(text);
    };
    const historyUp = () => {
      if (historyRef.current.length === 0) return;
      if (historyIdxRef.current === -1) historyIdxRef.current = historyRef.current.length - 1;
      else if (historyIdxRef.current > 0) historyIdxRef.current--;
      replaceLine(historyRef.current[historyIdxRef.current]);
    };
    const historyDown = () => {
      if (historyIdxRef.current === -1) return;
      if (historyIdxRef.current < historyRef.current.length - 1) {
        historyIdxRef.current++;
        replaceLine(historyRef.current[historyIdxRef.current]);
      } else {
        historyIdxRef.current = -1;
        replaceLine("");
      }
    };

    const dataDisposer = term.onData((data) => {
      if (closedRef.current) return;
      // ESC 控制序列（方向键等）整体优先处理
      if (data.startsWith("\x1b[A")) { historyUp(); return; }
      if (data.startsWith("\x1b[B")) { historyDown(); return; }
      if (data.startsWith("\x1b")) return; // 其他 ESC 序列忽略（管道模式不支持）
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const line = lineRef.current;
          if (line.length === 0) {
            // 空缓冲回车不发送：cmd 对"空回车"会重复执行上一条命令，
            // 这是粘贴末尾换行/分块输入导致"一次操作执行多次"的根源
            term.write("\r\n");
            continue;
          }
          send({ action: "terminal_input", id: SESSION_ID, data: line + "\r" });
          term.write("\r\n");
          if (line.trim()) {
            historyRef.current.push(line);
            if (historyRef.current.length > 50) historyRef.current.shift();
          }
          historyIdxRef.current = -1;
          lineRef.current = "";
        } else if (ch === "\x7f" || ch === "\b") {
          // 退格：缓冲为空时不删（保护提示符文字不被误删），非空则删除尾字符
          if (lineRef.current.length > 0) {
            lineRef.current = lineRef.current.slice(0, -1);
            term.write("\b \b");
          }
        } else if (ch === "\t") {
          // Tab：管道模式无补全，忽略（保持本地显示不乱）
        } else if (ch === "\x03") {
          // Ctrl+C 中断信号：cmd 管道模式无法真正中断进程，尽力转发远端 + 本地模拟 ^C
          send({ action: "terminal_input", id: SESSION_ID, data: "\x03" });
          term.write("^C\r\n");
          lineRef.current = "";
        } else if (ch >= " ") {
          lineRef.current += ch;
          term.write(ch); // 本地回显：让用户实时看到输入
        }
      }
    });

    const resizeDisposer = term.onResize(({ rows, cols }) => {
      if (!openedRef.current) return;
      send({ action: "terminal_resize", id: SESSION_ID, rows, cols });
    });

    const onWindowResize = () => {
      try { fitAddon.fit(); } catch { /* 忽略 */ }
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataDisposer.dispose();
      resizeDisposer.dispose();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        closedRef.current = true; // 主动关闭：onclose 不再提示
        if (openedRef.current) {
          try { ws.send(JSON.stringify({ action: "terminal_close", id: SESSION_ID })); } catch { /* 忽略 */ }
        }
        ws.close();
      }
      term.dispose();
    };
  }, [serverUrl, deviceId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-md p-4">
      <div className="bg-card border border-border w-full max-w-5xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-card border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-primary/10 border border-primary/20 text-primary rounded-xl">
              <TerminalIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                远程终端
                {deviceName && (
                  <span className="text-xs font-medium px-2 py-0.5 bg-primary/10 text-primary border border-primary/20 rounded-full">
                    {deviceName}
                  </span>
                )}
              </h3>
              <p className="text-xs text-muted-foreground">实时控制台指令会话 (WebSocket)</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Terminal container */}
        <div ref={containerRef} className="w-full h-[65vh] bg-[#1e1e1e] overflow-hidden" />
      </div>
    </div>
  );
};

export default TerminalModal;
