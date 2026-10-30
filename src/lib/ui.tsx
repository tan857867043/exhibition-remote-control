import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, XCircle, Info } from "lucide-react";

/* ═══════════════════════════════════════════
   Toast 提示系统（模块级事件模式，无 Context）
   ═══════════════════════════════════════════ */

export type ToastType = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let toastSeq = 0;
const toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();

function notifyToastListeners() {
  toastListeners.forEach((fn) => fn());
}

export function toast(message: string, type: ToastType = "info") {
  const id = ++toastSeq;
  toasts.push({ id, message, type });
  notifyToastListeners();
  setTimeout(() => {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx >= 0) {
      toasts.splice(idx, 1);
      notifyToastListeners();
    }
  }, 3200);
}

function dismissToast(id: number) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) {
    toasts.splice(idx, 1);
    notifyToastListeners();
  }
}

const TOAST_ICON: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />,
  error: <XCircle className="w-4 h-4 shrink-0 text-error" />,
  info: <Info className="w-4 h-4 shrink-0 text-primary" />,
};

export function Toaster() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const update = () => setTick((t) => t + 1);
    toastListeners.add(update);
    return () => { toastListeners.delete(update); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[120] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className="pointer-events-auto bg-card border border-border rounded-md px-3 py-2.5 text-sm shadow-lg flex items-center gap-2 cursor-pointer"
        >
          {TOAST_ICON[t.type]}
          <span className="whitespace-pre-line">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════
   确认 / 输入弹窗系统（模块级事件模式，无 Context）
   ═══════════════════════════════════════════ */

type DialogMode = "confirm" | "prompt";

interface DialogState {
  mode: DialogMode;
  message: string;
  defaultValue?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
}

let currentDialog: DialogState | null = null;
const dialogListeners = new Set<() => void>();

function notifyDialogListeners() {
  dialogListeners.forEach((fn) => fn());
}

export function confirmDialog(
  message: string,
  opts?: { okText?: string; cancelText?: string; danger?: boolean }
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    currentDialog = { mode: "confirm", message, ...opts, resolve };
    notifyDialogListeners();
  });
}

export function promptDialog(
  message: string,
  defaultValue?: string,
  opts?: { okText?: string; cancelText?: string }
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    currentDialog = { mode: "prompt", message, defaultValue, ...opts, resolve };
    notifyDialogListeners();
  });
}

export function answerDialog(value: boolean | string | null) {
  const dialog = currentDialog;
  currentDialog = null;
  notifyDialogListeners();
  dialog?.resolve(value);
}

export function DialogHost() {
  const [, setTick] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialog = currentDialog;

  useEffect(() => {
    const update = () => setTick((t) => t + 1);
    dialogListeners.add(update);
    return () => { dialogListeners.delete(update); };
  }, []);

  // 对话框切换 / 打开时重置输入值并聚焦
  useEffect(() => {
    if (currentDialog) {
      setInputValue(currentDialog.defaultValue ?? "");
    }
  }, [dialog]);

  useEffect(() => {
    if (currentDialog?.mode === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [dialog]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!currentDialog) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (currentDialog.mode === "confirm") {
          answerDialog(true);
        } else {
          const value = inputValue.trim();
          answerDialog(value || null);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        answerDialog(currentDialog.mode === "confirm" ? false : null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inputValue]);

  if (!currentDialog) return null;

  const { mode, message, okText, cancelText, danger } = currentDialog;

  const handleOk = () => {
    if (mode === "confirm") {
      answerDialog(true);
    } else {
      const value = inputValue.trim();
      answerDialog(value || null);
    }
  };

  const handleCancel = () => {
    answerDialog(mode === "confirm" ? false : null);
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg p-5 w-full max-w-sm shadow-2xl">
        <p className="text-sm text-foreground whitespace-pre-line leading-relaxed">{message}</p>

        {mode === "prompt" && (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="mt-3 w-full h-9 px-3 rounded-md bg-background border border-border text-sm text-foreground focus:outline-none focus:border-primary"
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-muted"
            style={{ background: "var(--ur-muted)", color: "var(--ur-muted-foreground)" }}
          >
            {cancelText ?? "取消"}
          </button>
          <button
            onClick={handleOk}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: danger ? "var(--ur-state-error)" : "var(--ur-primary-600)", color: "#fff" }}
          >
            {okText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
