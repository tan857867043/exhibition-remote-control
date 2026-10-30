//! 统一日志模块：线程安全追加写入 + 50MB 轮转，仅用 std，不依赖外部 crate。
//!
//! 日志目录：`%LOCALAPPDATA%\ExhibitionAgent\logs\`（LOCALAPPDATA 为空时回退
//! `%USERPROFILE%\AppData\Local\ExhibitionAgent\logs\`），文件名为 `agent.log`。
//! 所有失败均静默降级（不 panic、不输出），保证日志功能不影响主程序。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 日志文件名
const LOG_FILE_NAME: &str = "agent.log";
/// 单文件大小上限（50MB），达到后触发轮转
const MAX_LOG_SIZE: u64 = 50 * 1024 * 1024;

/// 全局日志文件句柄（None = 未初始化或打开失败）
static LOGGER: Mutex<Option<File>> = Mutex::new(None);

/// init() 成功后确定的日志目录
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 解析日志目录：优先 LOCALAPPDATA，为空则回退 USERPROFILE\AppData\Local
fn resolve_log_dir() -> Option<PathBuf> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            return Some(PathBuf::from(local).join("ExhibitionAgent").join("logs"));
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.trim().is_empty() {
            return Some(
                PathBuf::from(profile)
                    .join("AppData")
                    .join("Local")
                    .join("ExhibitionAgent")
                    .join("logs"),
            );
        }
    }
    None
}

/// 初始化日志系统：创建目录并打开文件。成功返回 true，失败静默返回 false。
pub fn init() -> bool {
    let Some(dir) = resolve_log_dir() else { return false; };
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let path = dir.join(LOG_FILE_NAME);
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return false;
    };
    let _ = LOG_DIR.set(dir);
    let mut guard = match LOGGER.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = Some(file);
    true
}

/// 轮转：删除最旧的 agent.log.5，依次把 agent.log.4..agent.log.1 后移，
/// 最后把 agent.log 重命名为 agent.log.1（调用方持有 LOGGER 锁）。
fn rotate() {
    let Some(dir) = LOG_DIR.get() else { return; };
    // 先删除最旧的
    let _ = fs::remove_file(dir.join("agent.log.5"));
    // 依次后移 4→5, 3→4, 2→3, 1→2
    for i in (1..=4).rev() {
        let from = dir.join(format!("agent.log.{}", i));
        let to = dir.join(format!("agent.log.{}", i + 1));
        let _ = fs::rename(&from, &to);
    }
    // 当前文件 → agent.log.1
    let _ = fs::rename(dir.join(LOG_FILE_NAME), dir.join("agent.log.1"));
}

/// 写入一行日志（线程安全 + 轮转）。文件不可用时静默丢弃。
pub fn log_line(level: &str, msg: &str) {
    let line = format!("[{}] [{}] {}\n", format_timestamp(), level, msg);
    let mut guard = match LOGGER.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(file) = &mut *guard else { return; };

    // 写入前检查大小，达到 50MB 则轮转并重新打开
    let over_limit = file
        .metadata()
        .map(|m| m.len() >= MAX_LOG_SIZE)
        .unwrap_or(false);
    if over_limit {
        rotate();
        if let Some(dir) = LOG_DIR.get() {
            if let Ok(new_file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(LOG_FILE_NAME))
            {
                *guard = Some(new_file);
            }
        }
    }
    // 轮转后重开失败则沿用旧句柄（继续写，静默）
    if let Some(file) = &mut *guard {
        let _ = file.write_all(line.as_bytes());
    }
}

/// 格式化时间戳：YYYY-MM-DD HH:MM:SS.mmm（UTC，手动公历换算，无外部依赖）
fn format_timestamp() -> String {
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();

    let days = secs / 86_400;
    let secs_of_day = secs % 86_400;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;

    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        year, month, day, hour, minute, second, millis
    )
}

/// Howard Hinnant 的 civil_from_days 算法：UNIX 纪元起的天数 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 便捷函数（宏的等价调用形式，供不需要格式化参数的调用使用）
#[allow(dead_code)]
pub fn log_info(msg: &str) {
    log_line("INFO", msg);
}
#[allow(dead_code)]
pub fn log_warn(msg: &str) {
    log_line("WARN", msg);
}
#[allow(dead_code)]
pub fn log_error(msg: &str) {
    log_line("ERROR", msg);
}

/// 宏：log_info!("...{}", x)
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::logger::log_line("INFO", &format!($($arg)*))
    };
}

/// 宏：log_warn!("...{}", x)
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::logger::log_line("WARN", &format!($($arg)*))
    };
}

/// 宏：log_error!("...{}", x)
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::logger::log_line("ERROR", &format!($($arg)*))
    };
}
