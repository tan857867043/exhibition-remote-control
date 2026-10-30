use std::process::Command;
use std::path::Path;
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 创建子进程并自动添加 CREATE_NO_WINDOW 标志，避免 GUI 子系统下弹出 cmd 黑框
fn command_no_window(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

const SERVICE_NAME: &str = "ExhibitionAgent";
const INSTALL_DIR: &str = "C:\\Program Files\\ExhibitionAgent";
const CONFIG_FILE: &str = "C:\\Program Files\\ExhibitionAgent\\config.json";
// HKLM Run = 所有用户登录都自启，--run = 用户态干活进程（截图 + 键鼠）
const REGKEY_RUN: &str = "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REGVAL_TRAY: &str = "ExhibitionAgent";

/// 追加一行到统一日志（不 panic，静默失败）
pub fn log(msg: &str) {
    crate::logger::log_line("SERVICE", msg);
}

/// 安装 ExhibitionAgent Windows 服务（支持覆盖更新）
pub fn install_service(hub_url: &str) -> Result<(), String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("无法获取自身路径: {}", e))?;
    let install_exe = format!("{}\\exhibition-agent.exe", INSTALL_DIR);

    // 0. 停止旧服务 + 杀所有用户态 agent，释放句柄（不然 copy 被 AV 拦截）
    if is_service_installed() {
        println!("[Service] 服务已存在，正在停止旧服务...");
        let _ = command_no_window("sc.exe").args(["stop", SERVICE_NAME]).output();
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    let _ = command_no_window("taskkill").args([
        "/F", "/IM", "exhibition-agent.exe",
        "/FI", &format!("PID ne {}", std::process::id()),
    ]).output();
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 1. 目录
    std::fs::create_dir_all(INSTALL_DIR)
        .map_err(|e| format!("无法创建安装目录 {}: {}", INSTALL_DIR, e))?;

    // 2. 复制：直接 copy 失败就 rename .old + 再 copy（绕过 AV）
    match std::fs::copy(&exe_path, &install_exe) {
        Ok(_) => println!("[Service] 已复制到 {}", install_exe),
        Err(e) => {
            let old = format!("{}.old-{}", install_exe, std::process::id());
            println!("[Service] 直接覆盖失败: {}, rename-swap → {}", e, old);
            let _ = std::fs::rename(&install_exe, &old);
            std::fs::copy(&exe_path, &install_exe)
                .map_err(|e2| format!("无法复制到 {}: {}", install_exe, e2))?;
            println!("[Service] rename-swap 成功: {}", install_exe);
        }
    }
    // 清旧 .old 垃圾
    let _ = std::fs::read_dir(INSTALL_DIR).map(|rd| {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("exhibition-agent.exe.old-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    });

    // 3. 保存 config
    let config = serde_json::json!({ "server_url": hub_url }).to_string();
    std::fs::write(CONFIG_FILE, &config)
        .map_err(|e| format!("无法保存配置: {}", e))?;

    // 4. sc delete + sc create
    if is_service_installed() {
        println!("[Service] 删除旧服务定义...");
        let _ = command_no_window("sc.exe").args(["delete", SERVICE_NAME]).output();
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    let bin_path = format!("\"{}\" --service", install_exe);
    let out = command_no_window("sc.exe")
        .args(["create", SERVICE_NAME,
               "binPath=", &bin_path,
               "start=", "auto",
               "DisplayName=", "Exhibition Remote Control Agent"])
        .output()
        .map_err(|e| format!("sc create 执行失败: {}", e))?;
    if !out.status.success() {
        let s = String::from_utf8_lossy(&out.stderr);
        let s_out = String::from_utf8_lossy(&out.stdout);
        if !s.contains("ALREADY_EXISTS") && !s.contains("already exists") {
            if !s.trim().is_empty() {
                return Err(format!("sc create 失败: {}", s));
            }
            if !s_out.trim().is_empty() {
                // GBK 编码错误转成 UTF-8 显示
                let s_out_lossy = String::from_utf8_lossy(&out.stdout);
                return Err(format!("sc create 失败: {}", s_out_lossy));
            }
            // 完全没有输出 → PowerShell 兜底
            log("[Service] sc.exe returned error with empty output, trying PowerShell New-Service fallback...");
            let ps_cmd = format!(
                "New-Service -Name '{}' -BinaryPathName '{}' -StartupType Automatic -DisplayName 'Exhibition Remote Control Agent'",
                SERVICE_NAME, bin_path.replace('\'', "''")
            );
            let ps_out = command_no_window("powershell")
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps_cmd])
                .output()
                .map_err(|e| format!("PowerShell New-Service 失败: {}", e))?;
            if !ps_out.status.success() {
                let ps_err = String::from_utf8_lossy(&ps_out.stderr);
                let ps_stdout = String::from_utf8_lossy(&ps_out.stdout);
                return Err(format!("PowerShell New-Service 也失败: stderr={}, stdout={}", ps_err, ps_stdout));
            }
            log("[Service] PowerShell New-Service fallback 成功");
            println!("[Service] PowerShell New-Service fallback 成功");
        } else {
            println!("[Service] 服务已存在，跳过创建");
        }
    } else {
        println!("[Service] 服务创建成功");
        // sc create 不支持 description= 参数，需单独设置描述
        let _ = command_no_window("sc.exe").args(["description", SERVICE_NAME,
            "Exhibition 远程控制 Agent 守护服务（Session-guard）"]).output();
    }

    // 5. sc failure：配置服务崩溃自动恢复（第一次 10s，第二次 60s，第三次 300s 重启）
    // 配置服务崩溃自动恢复：第一次 10s，第二次 60s，第三次 300s 重启
    let _ = command_no_window("sc.exe")
        .args(["failure", SERVICE_NAME, "reset=", "3600",
               "actions=", "restart/10000/restart/60000/restart/300000"])
        .output();
    log("[Service] 配置服务恢复策略: restart 10s/60s/300s");

    // 6. sc start
    let out = command_no_window("sc.exe")
        .args(["start", SERVICE_NAME])
        .output()
        .map_err(|e| format!("sc start 执行失败: {}", e))?;
    if !out.status.success() {
        println!("[Service] 警告: 启动服务失败: {}（可能已在运行）", String::from_utf8_lossy(&out.stderr));
    } else {
        // 确认服务在跑
        for i in 1..=3 {
            std::thread::sleep(std::time::Duration::from_millis(800));
            let q = command_no_window("sc.exe").args(["query", SERVICE_NAME]).output();
            if let Ok(qo) = q {
                let txt = String::from_utf8_lossy(&qo.stdout);
                if txt.contains("RUNNING") {
                    println!("[Service] 服务运行中（第 {} 次确认）", i);
                    break;
                }
            }
        }
    }

    // 7. HKLM Run：所有用户一登录就启动用户态 worker（截图 + 键鼠）
    let run_val = format!("\"{}\" --run", install_exe);
    let out = command_no_window("reg.exe")
        .args(["add", REGKEY_RUN, "/v", REGVAL_TRAY, "/t", "REG_SZ", "/d", &run_val, "/f"])
        .output()
        .map_err(|e| format!("reg add 执行失败: {}", e))?;
    if !out.status.success() {
        println!("[Service] 警告: 添加 HKLM Run 失败: {}", String::from_utf8_lossy(&out.stderr));
    } else {
        println!("[Service] HKLM Run 启动项已添加（所有用户登录自启）: {}", run_val);
    }

    // 8. 本次安装直接拉用户态 worker（不用等下次登录）
    println!("[Service] 立即在当前登录用户会话启动 --run worker...");
    match ensure_one_run_worker_per_session(true) {
        Ok(n) if n > 0 => {
            println!("[Service] OK，已启动 {} 个 user-agent", n);
            log(&format!("[Service] ensure_one_run_worker_per_session OK, spawned={}", n));
        }
        Ok(_) => {
            println!("[Service] 暂时没发现已登录会话；用户登录时会通过 HKLM Run 自动拉起");
            log("[Service] ensure_one_run_worker_per_session: no sessions found, HKLM Run will handle");
        }
        Err(e) => {
            println!("[Service] 直接启动 user-agent 失败: {}（用户登录时自动拉起）", e);
            log(&format!("[Service] ensure_one_run_worker_per_session FAILED: {}", e));
        }
    }

    // 9. 写「卸载.bat」「配置服务器地址.bat」两个快捷脚本（用户双击就能用，不用记命令）
    write_uninstall_helper();
    write_config_helper();

    // 10. 桌面创建 3 个快捷方式（不用找安装目录）
    create_desktop_shortcuts();

    Ok(())
}

/// 卸载
pub fn uninstall_service() -> Result<(), String> {
    // 0. 先杀所有 agent（排除自身，避免自杀）
    let self_pid = std::process::id();
    let _ = command_no_window("taskkill").args([
        "/F", "/IM", "exhibition-agent.exe",
        "/FI", &format!("PID ne {}", self_pid),
    ]).output();
    std::thread::sleep(std::time::Duration::from_millis(500));
    // 1. sc stop
    let _ = command_no_window("sc.exe").args(["stop", SERVICE_NAME]).output();
    std::thread::sleep(std::time::Duration::from_secs(2));
    // 2. sc delete
    let out = command_no_window("sc.exe")
        .args(["delete", SERVICE_NAME])
        .output()
        .map_err(|e| format!("sc delete 执行失败: {}", e))?;
    if !out.status.success() {
        let s = String::from_utf8_lossy(&out.stderr);
        if !s.contains("SERVICE_DOES_NOT_EXIST") && !s.contains("does not exist") {
            return Err(format!("sc delete 失败: {}", s));
        }
        println!("[Service] 服务不存在，跳过删除");
    } else {
        println!("[Service] 服务已删除");
    }
    // 3. 目录
    if Path::new(INSTALL_DIR).exists() {
        if let Err(e) = std::fs::remove_dir_all(INSTALL_DIR) {
            println!("[Service] 警告: 删除安装目录失败（可能服务/用户态进程尚未退净: {}）", e);
        } else {
            println!("[Service] 安装目录已删除");
        }
    }
    // 4. 注册表
    let out = command_no_window("reg.exe")
        .args(["delete", REGKEY_RUN, "/v", REGVAL_TRAY, "/f"])
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            println!("[Service] HKLM Run 启动项已删除");
        }
    }
    // 5. 清守护进程可能留下的 schtasks（虽然 /Z 执行后自动删，保险起见）
    let _ = command_no_window("schtasks")
        .args(["/Delete", "/F", "/TN", "ExhibitionAgent_spawn"])
        .output();
    Ok(())
}

pub fn is_service_installed() -> bool {
    command_no_window("sc.exe")
        .args(["query", SERVICE_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn is_admin() -> bool {
    let _ = std::fs::create_dir_all(INSTALL_DIR);
    let test = format!("{}\\exhibition_admin_test.tmp", INSTALL_DIR);
    match std::fs::write(&test, b"") {
        Ok(_) => {
            let _ = std::fs::remove_file(&test);
            true
        }
        Err(_) => false,
    }
}

pub fn elevate_self() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法获取自身路径: {}", e))?;
    let args: Vec<String> = std::env::args().collect();
    let arg_str = if args.len() > 1 { args[1..].join(" ") } else { String::new() };
    let cmd = format!(
        "Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs",
        exe.display(), arg_str
    );
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-Command", &cmd])
        .output()
        .map_err(|e| format!("提权失败: {}", e))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

/// 提权并把指定参数传给提权实例（如 --config-ui-write=<url>，避免用户输入在提权后丢失）。
pub fn elevate_self_with_arg(extra_arg: &str) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法获取自身路径: {}", e))?;
    // PowerShell 单引号字符串转义：'' 表示一个字面单引号
    let safe = extra_arg.replace('\'', "''");
    let cmd = format!(
        "Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs",
        exe.display(), safe
    );
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-Command", &cmd])
        .output()
        .map_err(|e| format!("提权失败: {}", e))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

// ======================= 守护进程（SCM 服务 --service 模式调用）========================

/// 守护进程停止请求标志：SCM 收到 STOP/SHUTDOWN 控制时置位，守护循环据此退出。
/// 否则服务不响应 SCM 停止请求，sc stop 只能靠杀进程，SCM 会判定为强制停止。
static DAEMON_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Service 守护进程（Session 0 合法运行：不截图、不做键鼠注入）
/// 职责：
///   - 每 5 秒扫所有已登录（有 explorer.exe）的 Session
///   - 对每个 Session，如果没跑 `exhibition-agent.exe --run`（截图+键鼠 worker），
///     就用 `schtasks /Create /IT /SC ONCE /TN ... /TR ... /Z /RL HIGHEST` 拉一个
///   - /IT = 只在"用户已交互式登录的 session"里才会跑，刚好满足我们 Session ≥ 1 要桌面
pub fn run_service_daemon() {
    log("[ServiceDaemon] Starting SessionGuard for ExhibitionAgent (scan every 5s)...");

    let install_exe = format!("{}\\exhibition-agent.exe", INSTALL_DIR);
    let target_exe: String = if Path::new(&install_exe).exists() {
        install_exe
    } else {
        std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    };
    if target_exe.is_empty() {
        log("[ServiceDaemon] FATAL: cannot locate agent exe");
        eprintln!("[ServiceDaemon] FATAL: cannot locate agent exe");
        return;
    }

    let mut tick: u64 = 0;
    'daemon: loop {
        if DAEMON_STOP_REQUESTED.load(Ordering::Relaxed) {
            log("[ServiceDaemon] Stop requested, exiting daemon loop");
            break;
        }
        tick = tick.wrapping_add(1);
        // 5s 粒度扫；单次 PS 调用 ≈ 30~80ms，对 CPU 无压力
        match ensure_one_run_worker_per_session_via_schtasks(&target_exe) {
            Ok(0) => { /* 没登录用户，或者都在跑了，正常 */ }
            Ok(n) => log(&format!("[ServiceDaemon] tick={}, spawned {} user-agent(s)", tick, n)),
            Err(e) => log(&format!("[ServiceDaemon] tick={}, worker-spawn failed: {}", tick, e)),
        }
        // 分 50 次小 sleep 100ms，让 SCM 停止请求能及时生效
        for _ in 0..50 {
            if DAEMON_STOP_REQUESTED.load(Ordering::Relaxed) {
                log("[ServiceDaemon] Stop requested during sleep, exiting daemon loop");
                break 'daemon;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

/// 以 Windows 服务（SCM）方式运行守护进程。
/// 注册 StartServiceCtrlDispatcher + 控制 handler 并报告 RUNNING 状态，
/// 解决「服务启动后 30s 被 SCM 因未报告状态而停止」的问题。
/// SCM 注册失败（如非服务环境启动）时回退到普通无限循环。
pub fn run_as_service_daemon() {
    #[cfg(windows)]
    {
        match register_scm_service() {
            Ok(()) => log("[ServiceDaemon] SCM service dispatcher returned"),
            Err(e) => {
                log(&format!("[ServiceDaemon] SCM registration failed ({}), falling back to plain loop", e));
                run_service_daemon();
            }
        }
    }
    #[cfg(not(windows))]
    run_service_daemon();
}

#[cfg(windows)]
fn register_scm_service() -> Result<(), String> {
    use windows::Win32::System::Services::{
        SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP, SERVICE_STATUS, SERVICE_STATUS_CURRENT_STATE,
        SERVICE_STATUS_HANDLE, SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS, SetServiceStatus,
        StartServiceCtrlDispatcherW,
    };
    use windows::core::{w, PWSTR};

    // SCM 服务状态常量（SERVICE_STATE）
    const SERVICE_RUNNING: u32 = 4;
    const SERVICE_STOPPED: u32 = 1;
    // 控制请求常量（SERVICE_CONTROL_*）
    const SERVICE_CONTROL_STOP: u32 = 1;
    const SERVICE_CONTROL_SHUTDOWN: u32 = 5;

    DAEMON_STOP_REQUESTED.store(false, Ordering::Relaxed);

    unsafe extern "system" fn ctrl_handler(
        dwcontrol: u32,
        _dweventtype: u32,
        _lpeventdata: *mut std::ffi::c_void,
        _lpcontext: *mut std::ffi::c_void,
    ) -> u32 {
        match dwcontrol {
            SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
                crate::service::log("[ServiceDaemon] SCM stop/shutdown control received");
                DAEMON_STOP_REQUESTED.store(true, Ordering::Relaxed);
                0 // NO_ERROR：接受该控制请求
            }
            _ => 1, // ERROR_CALL_NOT_IMPLEMENTED：其他控制暂不支持
        }
    }

    fn report_status(handle: SERVICE_STATUS_HANDLE, state: u32) {
        let status = SERVICE_STATUS {
            dwServiceType: SERVICE_WIN32_OWN_PROCESS,
            dwCurrentState: SERVICE_STATUS_CURRENT_STATE(state),
            dwControlsAccepted: SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN,
            dwWin32ExitCode: 0,
            dwServiceSpecificExitCode: 0,
            dwCheckPoint: 0,
            dwWaitHint: 0,
        };
        unsafe { let _ = SetServiceStatus(handle, &status); }
    }

    unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
        use windows::Win32::System::Services as svc;
        let handle = match unsafe { svc::RegisterServiceCtrlHandlerExW(w!("ExhibitionAgent"), Some(ctrl_handler), Some(std::ptr::null())) } {
            Ok(h) => h,
            Err(e) => {
                crate::service::log(&format!("[ServiceDaemon] RegisterServiceCtrlHandlerExW failed: {}", e));
                return;
            }
        };
        report_status(handle, SERVICE_RUNNING);
        crate::service::log("[ServiceDaemon] SCM registered, status=RUNNING, SessionGuard loop starting");
        // 守护循环（SCM 收到 STOP 时经 DAEMON_STOP_REQUESTED 退出）
        crate::service::run_service_daemon();
        report_status(handle, SERVICE_STOPPED);
        crate::service::log("[ServiceDaemon] Daemon exited, status=STOPPED");
    }

    // 服务名 buffer 必须活得比 StartServiceCtrlDispatcherW 阻塞期间更久（同一栈帧，OK）
    let mut service_name: Vec<u16> = "ExhibitionAgent\0".encode_utf16().collect();
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: PWSTR(service_name.as_mut_ptr()),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) }.map_err(|e| e.to_string())
}

/// 保证"每个已登录 Session（有 explorer.exe）最多 1 个 --run user-agent"。
/// 返回本次实际新拉起的数量。
fn ensure_one_run_worker_per_session_via_schtasks(exe: &str) -> Result<i32, String> {
    // 1) 列出所有已登录 Session ID（跑着 explorer.exe 的）
    let logged = list_session_ids_with_explorer()?;
    if logged.is_empty() {
        return Ok(0);
    }
    // 2) 目前所有 exhibition-agent 进程所在 Session（不管 args，先占住 session 即可，
    //    避免守护+HKLM Run 同时启动多个同一机器 worker）
    let occupied = list_agent_occupied_sessions()?;
    let mut spawned = 0i32;
    let tr = format!("\"{}\" --run", exe);
    let st = next_10s_sch_time();
    for sid in logged {
        if occupied.contains(&sid) {
            continue;
        }
        // /IT 保证"该 sid 用户必须已登录有桌面"，/Z 执行完任务自动删除，/RL HIGHEST=管理员权限（截图高 DPI 游戏窗口都要）
        let tn = format!("ExhibitionAgent_spawn_{}_{}", sid, rand_like_suffix());
        let created = command_no_window("schtasks")
            .args(["/Create", "/F", "/IT", "/SC", "ONCE",
                   "/ST", &st, "/RL", "HIGHEST", "/TN", &tn, "/TR", &tr, "/Z"])
            .output();
        match created {
            Ok(o) if o.status.success() => {
                spawned += 1;
                // 注册完立刻 /Run 触发，不用等 10s
                let _ = command_no_window("schtasks").args(["/Run", "/TN", &tn]).output();
                log(&format!("[ServiceDaemon]   sid={}: schtasks registered and /Run fired", sid));
            }
            Ok(o) => log(&format!("[ServiceDaemon]   sid={}: schtasks create failed: {}",
                                  sid, String::from_utf8_lossy(&o.stderr))),
            Err(e) => log(&format!("[ServiceDaemon]   sid={}: schtasks exec: {}", sid, e)),
        }
    }
    Ok(spawned)
}

/// 安装时立刻拉起当前用户会话的 worker（跟守护逻辑复用）
pub fn ensure_one_run_worker_per_session(force_trigger: bool) -> Result<i32, String> {
    let exe = current_or_installed_exe();
    let res = ensure_one_run_worker_per_session_via_schtasks(&exe)?;
    // 如果 schtasks 没拉起任何 worker（比如当前系统没有 explorer.exe），直接用进程 spawn
    if force_trigger && res == 0 {
        // 先杀掉当前 session 里已有的 --run worker，避免重复
        let sid = get_current_session_id_via_ps();
        kill_run_workers_in_session(sid);
        std::thread::sleep(std::time::Duration::from_millis(500));

        log(&format!("[WorkerSpawn] force_trigger=true, schtasks returned 0, spawning --run directly. exe={}", exe));
        let mut cmd = command_no_window(&exe);
        cmd.arg("--run");
        match cmd.spawn() {
            Ok(child) => {
                log(&format!("[WorkerSpawn] OK, child pid={}", child.id()));
                return Ok(child.id() as i32);
            }
            Err(e) => {
                log(&format!("[WorkerSpawn] FAILED: {}", e));
                return Err(format!("spawn in current session failed: {}", e));
            }
        }
    }
    Ok(res)
}

/// 杀掉指定 session 里所有 exhibition-agent.exe --run 进程（不含本进程）
fn kill_run_workers_in_session(sid: u32) {
    let self_pid = std::process::id();
    let ps_cmd = format!(
        "Get-Process exhibition-agent -ErrorAction SilentlyContinue | Where-Object {{ $_.SessionId -eq {sid} -and $_.Id -ne {self_pid} }} | Stop-Process -Force",
        sid = sid, self_pid = self_pid
    );
    let _ = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps_cmd])
        .output();
}

// ======================= helpers：纯 PowerShell / schtasks，无外部 crate ====================

/// 弹 Win32 MessageBox（PS + Forms Assembly，0 新 crate）
pub fn msgbox(text: &str, title: &str, icon: &str) {
    let icon_p1 = match icon {
        "error" => "MessageBoxIcon::Error",
        "warn" | "warning" => "MessageBoxIcon::Warning",
        "info" => "MessageBoxIcon::Information",
        "question" => "MessageBoxIcon::Question",
        _ => "MessageBoxIcon::Information",
    };
    // 转义单引号（PowerShell）+ 转义换行
    let safe_text = text.replace('\'', "''").replace('\r', "").replace('\n', "' + [Environment]::NewLine + '");
    let safe_title = title.replace('\'', "''");
    let cmd = format!(
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('{}', '{}', [System.Windows.Forms.MessageBoxButtons]::OK, {}) | Out-Null",
        if safe_text.is_empty() { "OK" } else { safe_text.as_str() },
        if safe_title.is_empty() { "Exhibition Agent" } else { safe_title.as_str() },
        icon_p1
    );
    let _ = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &cmd])
        .output();
}

/// 弹 Yes/No 确认框，返回 true=Yes
pub fn confirm(text: &str, title: &str) -> bool {
    let safe_text = text.replace('\'', "''").replace('\r', "").replace('\n', "' + [Environment]::NewLine + '");
    let safe_title = title.replace('\'', "''");
    let cmd = format!(
        "Add-Type -AssemblyName System.Windows.Forms; [int]([System.Windows.Forms.MessageBox]::Show('{}', '{}', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)) -eq 6",
        if safe_text.is_empty() { "Continue?" } else { safe_text.as_str() },
        if safe_title.is_empty() { "Exhibition Agent" } else { safe_title.as_str() }
    );
    match command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &cmd])
        .output()
    {
        Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim().ends_with("True"),
        Err(_) => false,
    }
}

/// 弹输入框（Microsoft.VisualBasic.Interaction.InputBox），默认值可填；取消返回 None
pub fn input_box(prompt: &str, title: &str, default: &str) -> Option<String> {
    let safe_p = prompt.replace('\'', "''").replace('\r', "").replace('\n', "' + [Environment]::NewLine + '");
    let safe_t = title.replace('\'', "''");
    let safe_d = default.replace('\'', "''");
    let cmd = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; $r = [Microsoft.VisualBasic.Interaction]::InputBox('{}', '{}', '{}'); if ([string]::IsNullOrEmpty($r)) {{ 'CANCELLED' }} else {{ $r }}",
        if safe_p.is_empty() { "Please input" } else { safe_p.as_str() },
        if safe_t.is_empty() { "Exhibition Agent" } else { safe_t.as_str() },
        safe_d
    );
    match command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &cmd])
        .output()
    {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() || s == "CANCELLED" { None } else { Some(s) }
        }
        _ => None,
    }
}

fn current_or_installed_exe() -> String {
    let p = format!("{}\\exhibition-agent.exe", INSTALL_DIR);
    if Path::new(&p).exists() { return p; }
    std::env::current_exe().map(|e| e.to_string_lossy().to_string()).unwrap_or(p)
}

fn list_session_ids_with_explorer() -> Result<Vec<u32>, String> {
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId | Sort-Object -Unique"])
        .output()
        .map_err(|e| format!("ps list explorer sessions failed: {}", e))?;
    if !out.status.success() {
        return Err(format!("ps exit={}, {}", out.status, String::from_utf8_lossy(&out.stderr)));
    }
    let mut v = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let s = line.trim();
        if let Ok(n) = s.parse::<u32>() {
            if n != 0 { v.push(n); }
        }
    }
    Ok(v)
}

fn list_agent_occupied_sessions() -> Result<std::collections::HashSet<u32>, String> {
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "Get-Process exhibition-agent -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId | Sort-Object -Unique"])
        .output()
        .map_err(|e| format!("ps list agent sessions failed: {}", e))?;
    let mut set = std::collections::HashSet::new();
    if !out.status.success() {
        // Get-Process 报错=没进程，返回空即可
        return Ok(set);
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let s = line.trim();
        if let Ok(n) = s.parse::<u32>() {
            set.insert(n);
        }
    }
    Ok(set)
}

fn get_current_session_id_via_ps() -> u32 {
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "Get-Process -Id $PID | Select-Object -ExpandProperty SessionId"])
        .output().ok();
    if let Some(o) = out {
        if o.status.success() {
            let txt = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if let Ok(n) = txt.parse::<u32>() { return n; }
        }
    }
    1 // 兜底：假设当前是 Session 1（大多数单用户桌面）
}

fn next_10s_sch_time() -> String {
    // 直接用 PowerShell Get-Date 拼，最稳，兼容所有本地化 Windows
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "(Get-Date).AddSeconds(10).ToString('HH:mm:ss')"])
        .output().ok();
    if let Some(o) = out {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() { return s; }
        }
    }
    // 兜底（本地时区不准没关系，schtasks ONCE 允许宽 1 分钟的边界）
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() + 15).unwrap_or(15);
    let t = secs % 86400;
    format!("{:02}:{:02}:{:02}", (t / 3600) % 24, (t / 60) % 60, t % 60)
}

fn rand_like_suffix() -> u64 {
    // 真随机 crate 也没加，就用 SystemTime nanos 当唯一值（1 毫秒内不会注册两次）
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

// ======================= 桌面快捷方式 / 打开浏览器 =======================

/// 取当前用户桌面路径
fn get_desktop_dir() -> String {
    let out = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "[Environment]::GetFolderPath('Desktop')"])
        .output().ok();
    if let Some(o) = out {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() { return s; }
        }
    }
    // 兜底：C:\Users\<user>\Desktop
    if let Ok(home) = std::env::var("USERPROFILE") {
        format!("{}\\Desktop", home)
    } else {
        "C:\\Users\\Public\\Desktop".to_string()
    }
}

/// 创建一个 .lnk 快捷方式（PowerShell + WScript.Shell，0 新 crate）
fn create_shortcut(link_path: &str, target: &str, args: &str, work_dir: &str, icon: &str, desc: &str) {
    let safe_link = link_path.replace('\'', "''");
    let safe_target = target.replace('\'', "''");
    let safe_args = args.replace('\'', "''");
    let safe_wd = work_dir.replace('\'', "''");
    let safe_icon = icon.replace('\'', "''");
    let safe_desc = desc.replace('\'', "''");
    let cmd = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); \
         $s.TargetPath='{}'; $s.Arguments='{}'; $s.WorkingDirectory='{}'; \
         $s.IconLocation='{}'; $s.Description='{}'; $s.Save();",
        safe_link, safe_target, safe_args, safe_wd, safe_icon, safe_desc
    );
    let _ = command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &cmd])
        .output();
}

/// 安装后在桌面创建 3 个快捷方式：卸载 / 改服务器地址 / 打开控制台
pub fn create_desktop_shortcuts() {
    let desk = get_desktop_dir();
    let inst = INSTALL_DIR.to_string();
    let exe = format!("{}\\exhibition-agent.exe", inst);
    let ico = format!("{},0", exe); // 用 exe 自身的第一个图标

    // 1. 卸载
    create_shortcut(
        &format!("{}\\卸载 Exhibition Agent.lnk", desk),
        &exe, "--uninstall-ui", &inst, &ico, "一键卸载 Exhibition Agent（服务+启动项+目录）"
    );
    // 2. 改服务器地址
    create_shortcut(
        &format!("{}\\配置服务器地址.lnk", desk),
        &exe, "--config-ui", &inst, &ico, "修改 Hub 服务器连接地址"
    );
    // 3. 打开控制台（用配置里的 server_url 拼 http 页面）
    let cfg: Option<String> = std::fs::read_to_string(CONFIG_FILE).ok();
    let ws_url = cfg.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("server_url").and_then(|u| u.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "ws://localhost:38921/ws".to_string());
    let http_url = ws_url
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches("/ws")
        .trim_end_matches('/')
        .to_string();
    // 打开 URL 用 rundll32 方式（兼容所有浏览器），target 写成 %windir%\system32\cmd.exe 启动
    let cmd_exe = format!("{}\\system32\\cmd.exe", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string()));
    let open_arg = format!("/c start \"\" \"{}\"", http_url);
    create_shortcut(
        &format!("{}\\Exhibition 控制台.lnk", desk),
        &cmd_exe, &open_arg, &inst, &ico, "打开 Exhibition 远程控制管理界面"
    );
}

/// 用默认浏览器打开一个 URL（安装成功后自动打开控制台）
pub fn open_url_in_browser(url: &str) {
    let safe = url.replace('\'', "''").replace('\"', "");
    // 策略 A: rundll32 url.dll,FileProtocolHandler（最稳）
    let r1 = command_no_window("rundll32")
        .args(["url.dll,FileProtocolHandler", &safe])
        .output();
    if r1.as_ref().map(|o| o.status.success()).unwrap_or(false) { return; }
    // 策略 B: cmd /c start
    let _ = command_no_window("cmd")
        .args(["/c", "start", "", &safe])
        .output();
}

/// 根据 ws:// URL 拼出对应的 http:// 控制台首页
pub fn ws_to_http_url(ws: &str) -> String {
    ws.replace("wss://", "https://")
      .replace("ws://", "http://")
      .trim_end_matches("/ws")
      .trim_end_matches('/')
      .to_string()
}

/// 安装结束后写一个卸载快捷 bat 到安装目录，用户双击就能一键卸载（管理员会自动提权）
pub fn write_uninstall_helper() {
    let p = format!("{}\\卸载.bat", INSTALL_DIR);
    let content = r#"@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"
if exist exhibition-agent.exe (
    echo 正在卸载 Exhibition Agent ...
    exhibition-agent.exe --uninstall
) else (
    echo exhibition-agent.exe 不存在
)
pause
"#;
    let _ = std::fs::write(p, content);
}

/// 安装结束后写一个「服务器地址配置.bat」，用户双击改完点保存就写 config.json 重启 worker
pub fn write_config_helper() {
    let p = format!("{}\\配置服务器地址.bat", INSTALL_DIR);
    let content = r#"@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist config.json (
    echo {"server_url":""} > config.json
)
powershell -NoProfile -WindowStyle Hidden -Command ^
  "Add-Type -AssemblyName Microsoft.VisualBasic; $def=(Get-Content config.json -Raw | ConvertFrom-Json).server_url; if(-not $def){$def='ws://localhost:38921/ws'}; $r=[Microsoft.VisualBasic.Interaction]::InputBox('请输入 Hub 服务器地址（示例：ws://192.168.1.10:38921/ws）','配置 Exhibition Agent 服务器地址',$def); if([string]::IsNullOrEmpty($r)){ exit 1 }; $j=Get-Content config.json -Raw | ConvertFrom-Json; $j.server_url=$r; $j | ConvertTo-Json -Compress | Out-File config.json -Encoding utf8; echo $r" >"%TEMP%\exhibition_agent_new_url.txt" 2>nul
if not exist "%TEMP%\exhibition_agent_new_url.txt" (
    echo 未配置
    pause
    exit /b
)
set /p NEWURL=<"%TEMP%\exhibition_agent_new_url.txt"
del "%TEMP%\exhibition_agent_new_url.txt" 2>nul
if "%NEWURL%"=="" (
    echo 未修改
    pause
    exit /b
)
echo 服务器地址已设置为：%NEWURL%
echo 正在重启 exhibition-agent worker ...
taskkill /F /IM exhibition-agent.exe /FI "SESSIONNAME ge 0" 2>nul
timeout /t 2 >nul
echo 完成，服务守护进程会自动重新拉起 worker。
pause
"#;
    let _ = std::fs::write(p, content);
}
