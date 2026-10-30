//! 远程终端（控制台指令）支持。
//!
//! Hub 通过既有 WebSocket 下发 terminal_open/input/resize/close 指令，
//! Agent 在本机以隐藏窗口方式 spawn cmd.exe（CREATE_NO_WINDOW，防弹黑窗），
//! 读取其 stdout/stderr（GBK → UTF-8）并经事件通道回传给 Hub。
//!
//! 说明：
//! - 会话注册表为全局静态，并发上限 4 个；
//! - 所有阻塞 IO（读管道 / 等进程退出）都在独立 OS 线程，不阻塞 tokio 运行时；
//! - 会话退出（进程自行结束或被杀）后自动从注册表移除并上报 Closed 事件。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{LazyLock, Mutex, MutexGuard};

// #[macro_export] 的日志宏位于 crate 根，子模块需显式导入
use crate::{log_error, log_info, log_warn};

/// 并发终端会话上限
const MAX_SESSIONS: usize = 4;

/// 终端事件（由后台线程产生，经 mpsc 转发为 WS 文本消息）
pub enum TerminalEvent {
    /// 终端输出（已转 UTF-8，含 ANSI 转义）
    Output { id: u32, data: String },
    /// 会话结束（exit_code 为 None 表示取不到退出码）
    Closed { id: u32, exit_code: Option<i32> },
}

/// 单个终端会话
pub struct TerminalSession {
    // 会话 id 与注册表 key 相同，按协议规格保留（供日志/调试引用）
    #[allow(dead_code)]
    pub id: u32,
    pub child: Child,
    // Option：write_input 会临时取出句柄写入（避免持锁阻塞），写回后恢复
    pub stdin: Option<ChildStdin>,
    pub rows: u16,
    pub cols: u16,
}

/// 全局会话注册表（id → 会话）
static SESSIONS: LazyLock<Mutex<HashMap<u32, TerminalSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 加锁 SESSIONS（Mutex 中毒不 panic，记日志后恢复最后一致状态）
fn lock_sessions() -> MutexGuard<'static, HashMap<u32, TerminalSession>> {
    match SESSIONS.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            log_error!("[Terminal] SESSIONS mutex poisoned, recovering last state");
            poisoned.into_inner()
        }
    }
}

/// 启动一个新终端会话。成功返回子进程 PID。
/// - 并发会话数已达上限（4）时返回 Err("too many sessions")
/// - 同 id 已存在时先清理旧会话（防止 Hub 复用 id 造成泄漏）
pub fn spawn_session(
    id: u32,
    rows: u16,
    cols: u16,
    out_tx: Sender<TerminalEvent>,
) -> Result<u32, String> {
    {
        let mut sessions = lock_sessions();
        if sessions.len() >= MAX_SESSIONS {
            return Err("too many sessions".to_string());
        }
        // 同 id 已存在：先杀旧会话再创建
        if let Some(mut old) = sessions.remove(&id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
            log_warn!("[Terminal] session {} re-created, old process killed", id);
        }
    }

    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/Q", "/K"]);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW (0x08000000)：隐藏 cmd 黑窗（防止无控制台程序弹窗闪烁）
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;
    let pid = child.id() as u32;
    let stdin = child.stdin.take().ok_or("stdin not available")?;
    let stdout = child.stdout.take().ok_or("stdout not available")?;
    let stderr = child.stderr.take().ok_or("stderr not available")?;

    lock_sessions().insert(id, TerminalSession { id, child, stdin: Some(stdin), rows, cols });

    spawn_output_reader(stdout, stderr, id, out_tx);
    log_info!("[Terminal] session {} spawned (pid={}, {}x{})", id, pid, cols, rows);
    Ok(pid)
}

/// 向会话写输入（data 为 UTF-8 文本，内部转 GBK 字节 + 换行标准化后写入 stdin）。
/// 会话不存在或写入失败返回 false。
pub fn write_input(id: u32, data: &str) -> bool {
    // 换行标准化：cmd 管道模式要求命令以 \r\n 结束，而 xterm 回车键发的是单独的 \r，
    // 把单独的 \r（0x0D）转为 \r\n，已带 \n 或本身就是 \r\n 的保持不变。
    let mut norm = String::with_capacity(data.len() + 2);
    let bytes = data.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            norm.push('\r');
            if i + 1 >= bytes.len() || bytes[i + 1] != b'\n' {
                norm.push('\n');
            }
        } else {
            // 按 UTF-8 边界逐字符透传，避免多字节 UTF-8 被逐字节拆坏
            let ch = data[i..].chars().next().unwrap_or('\u{FFFD}');
            norm.push(ch);
            i += ch.len_utf8();
            continue;
        }
        i += 1;
    }
    // cmd 默认代码页 GBK(936)：输入必须转成 GBK 字节，中文才能被 cmd 正确解析
    let (gbk_bytes, _, _) = encoding_rs::GBK.encode(&norm);

    // 锁粒度优化：只在锁内取出 stdin 句柄，随后释放锁再阻塞写入，
    // 避免管道写满（cmd 不再读 stdin）时长时间持锁，卡死整个终端子系统。
    let stdin = {
        let mut sessions = lock_sessions();
        match sessions.get_mut(&id) {
            Some(session) => session.stdin.take(),
            None => return false,
        }
    };
    let Some(mut stdin) = stdin else {
        return false;
    };

    let ok = stdin.write_all(&gbk_bytes).is_ok() && stdin.flush().is_ok();

    // 写完后把句柄放回会话（若会话已被关闭则自然释放）
    let mut sessions = lock_sessions();
    if let Some(session) = sessions.get_mut(&id) {
        session.stdin = Some(stdin);
    }
    ok
}

/// 更新会话尺寸（仅更新注册表记录，供后续扩展使用）。
pub fn resize_session(id: u32, rows: u16, cols: u16) {
    let mut sessions = lock_sessions();
    if let Some(session) = sessions.get_mut(&id) {
        session.rows = rows;
        session.cols = cols;
        log_info!("[Terminal] session {} resized to {}x{}", id, cols, rows);
    }
}

/// 关闭会话：kill 子进程并从注册表移除，返回退出码（会话不存在返回 None）。
pub fn close_session(id: u32) -> Option<i32> {
    let session = lock_sessions().remove(&id)?;
    let mut child = session.child;
    let _ = child.kill();
    let exit_code = child.wait().ok().and_then(|st| st.code());
    log_info!("[Terminal] session {} closed by hub, exit_code={:?}", id, exit_code);
    exit_code
}

/// 连接断开时调用：kill 所有子进程并清空注册表。
pub fn shutdown_all() {
    // 先 drain 到本地再逐个 kill，避免长时间持锁（kill/wait 可能阻塞）
    let sessions = lock_sessions().drain().collect::<Vec<_>>();
    let count = sessions.len();
    for (_, mut s) in sessions {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    log_info!("[Terminal] shutdown_all: killed {} session(s)", count);
}

/// 启动输出读取线程：stdout 读线程承担生命周期管理（EOF → 等待退出 → 移除会话 → 上报 Closed），
/// stderr 排空线程防止子进程大量写 stderr 时管道缓冲写满而阻塞。
fn spawn_output_reader(stdout: ChildStdout, stderr: ChildStderr, id: u32, out_tx: Sender<TerminalEvent>) {
    // stdout 读取线程
    let stdout_tx = out_tx.clone();
    std::thread::spawn(move || {
        let mut stdout = stdout;
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::with_capacity(8192);
        loop {
            let n = match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            push_and_send(&mut pending, &buf[..n], id, &stdout_tx);
        }
        flush_pending(&mut pending, id, &stdout_tx);

        // stdout 已读到 EOF：进程即将/已经退出，拿退出码并移除会话
        if let Some(session) = lock_sessions().remove(&id) {
            let wait_tx = stdout_tx;
            std::thread::spawn(move || {
                let mut child = session.child;
                let exit_code = child.wait().ok().and_then(|st| st.code());
                let _ = wait_tx.send(TerminalEvent::Closed { id, exit_code });
                log_info!("[Terminal] session {} exited, exit_code={:?}", id, exit_code);
            });
        }
    });

    // stderr 排空线程
    std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::with_capacity(8192);
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            push_and_send(&mut pending, &buf[..n], id, &out_tx);
        }
        flush_pending(&mut pending, id, &out_tx);
    });
}

/// 追加一段字节并尝试 GBK 解码发送；末尾可能被截断的双字节序列保留待下段拼接。
fn push_and_send(pending: &mut Vec<u8>, chunk: &[u8], id: u32, tx: &Sender<TerminalEvent>) {
    pending.extend_from_slice(chunk);
    let keep = gbk_incomplete_tail(pending);
    let cut = pending.len() - keep;
    if cut > 0 {
        let (text, _, _) = encoding_rs::GBK.decode(&pending[..cut]);
        if !text.is_empty() {
            let _ = tx.send(TerminalEvent::Output { id, data: text.into_owned() });
        }
        pending.drain(..cut);
    }
}

/// 流结束：把剩余字节全部解码发送。
fn flush_pending(pending: &mut Vec<u8>, id: u32, tx: &Sender<TerminalEvent>) {
    if !pending.is_empty() {
        let (text, _, _) = encoding_rs::GBK.decode(pending);
        if !text.is_empty() {
            let _ = tx.send(TerminalEvent::Output { id, data: text.into_owned() });
        }
        pending.clear();
    }
}

/// 从左到右扫描 GBK 字节流，判断末尾是否存在"未完成的双字节序列"（悬挂首字节）。
/// 返回应保留的字节数（0 或 1），其余部分可安全解码。
fn gbk_incomplete_tail(buf: &[u8]) -> usize {
    let mut i = 0;
    let mut dangling = false;
    while i < buf.len() {
        let b = buf[i];
        if (0x81..=0xFE).contains(&b) {
            // 可能是 GBK 双字节序列首字节
            if i + 1 < buf.len() {
                i += 2;
                dangling = false;
            } else {
                dangling = true;
                i += 1;
            }
        } else {
            // 单字节字符（ASCII / 0x80 / 0xFF 等）
            i += 1;
            dangling = false;
        }
    }
    if dangling { 1 } else { 0 }
}
