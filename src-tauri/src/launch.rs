// 「在資料夾開啟 Helm」：CLI（`helm .`、`helm C:\path`）與檔案總管右鍵選單
// 都是同一條路徑 —— 把要開啟的資料夾從 argv 解析出來，交給前端開 session。
//
// 兩種進入時機：
//   1. 冷啟動：run() 一開始解析 std::env::args()，存進 LaunchFolder（前端
//      bootstrap 時用 launch_folder 指令取回，取後清空）。
//   2. 已有視窗時再啟動一次：single-instance plugin 把第二個行程的 argv 與
//      cwd 轉進來，直接以 app://open-folder 事件送給前端。
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 冷啟動解析到的資料夾，等前端 bootstrap 來取。取出即清空（Option::take）：
/// 這是一次性的啟動意圖，前端熱重載不該重複開 session。
#[derive(Default)]
pub struct LaunchFolder(pub Mutex<Option<String>>);

/// 前端 bootstrap 呼叫：取回本次啟動要開的資料夾（沒有則 None）。
#[tauri::command]
pub fn launch_folder(state: tauri::State<'_, LaunchFolder>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// argv（不含程式路徑本身）中第一個「像路徑」的參數。
///
/// 刻意不引入 clap 之類的解析器：Helm 只認一個位置參數，而 `--flag` 一律略過
/// 可讓未來新增旗標不必回頭改這裡。單獨的 `-`／`--` 也不是路徑。
pub fn folder_arg(args: &[String]) -> Option<&str> {
    args.iter()
        .map(String::as_str)
        .find(|a| !a.starts_with('-') && !a.is_empty())
}

/// 把使用者給的路徑解析成一個實際存在的絕對目錄。
///
/// - 相對路徑（含 `.`）以 `base`（啟動時的工作目錄）為基準；檔案總管右鍵傳的
///   是絕對路徑，CLI 的 `helm .` 則靠 base。
/// - 指到檔案時取其所在目錄 —— 「用 Helm 開啟這個檔案」的合理解讀是開在它旁邊。
/// - 不存在就回 None：寧可照常啟動，也不要拿壞路徑去 spawn PTY。
pub fn resolve_folder(arg: &str, base: &Path) -> Option<PathBuf> {
    let joined = base.join(arg);
    // canonicalize 解掉 `.`、`..` 與 symlink，順便確認真的存在。
    let full = std::fs::canonicalize(joined).ok()?;
    if full.is_dir() {
        Some(strip_unc(full))
    } else {
        full.parent().map(|p| strip_unc(p.to_path_buf()))
    }
}

/// Windows 的 canonicalize 會回 `\\?\C:\path` 這種 UNC 形式。這個字串會一路
/// 流到 workspace folder、session cwd 與側欄顯示，其中 workspace 比對是字面
/// 比對，UNC 前綴會讓同一個資料夾被當成兩個；顯示上也難看。
fn strip_unc(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// 從一組 argv + 工作目錄算出要開的資料夾（冷啟動與 single-instance 共用）。
pub fn folder_from_args(args: &[String], cwd: &Path) -> Option<String> {
    let arg = folder_arg(args)?;
    Some(resolve_folder(arg, cwd)?.to_string_lossy().into_owned())
}

/// 冷啟動時呼叫：解析本行程的 argv，結果留給前端來取。
pub fn capture_startup_folder() -> LaunchFolder {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    LaunchFolder(Mutex::new(folder_from_args(&args, &cwd)))
}

/// single-instance 回呼：第二次啟動時把視窗帶到前景，並把資料夾送去前端。
pub fn handle_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    // args[0] 是程式路徑（與 std::env::args 一致），跳過。
    let rest: Vec<String> = args.into_iter().skip(1).collect();
    if let Some(folder) = folder_from_args(&rest, Path::new(&cwd)) {
        let _ = app.emit("app://open-folder", folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_arg_takes_first_positional() {
        let args = vec!["/some/path".to_string(), "other".to_string()];
        assert_eq!(folder_arg(&args), Some("/some/path"));
    }

    #[test]
    fn folder_arg_skips_flags() {
        let args = vec!["--verbose".to_string(), "-x".to_string(), ".".to_string()];
        assert_eq!(folder_arg(&args), Some("."));
    }

    #[test]
    fn folder_arg_none_when_only_flags() {
        let args = vec!["--verbose".to_string()];
        assert_eq!(folder_arg(&args), None);
    }

    #[test]
    fn folder_arg_none_when_empty() {
        assert_eq!(folder_arg(&[]), None);
    }

    #[test]
    fn resolve_folder_accepts_dot_relative_to_base() {
        let base = std::env::temp_dir();
        let resolved = resolve_folder(".", &base).expect("temp dir resolves");
        assert!(resolved.is_dir());
    }

    #[test]
    fn resolve_folder_rejects_missing_path() {
        let base = std::env::temp_dir();
        assert_eq!(resolve_folder("helm-no-such-dir-xyzzy", &base), None);
    }

    #[test]
    fn resolve_folder_of_a_file_yields_its_parent() {
        let dir = std::env::temp_dir().join("helm-launch-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").unwrap();

        let resolved = resolve_folder(file.to_str().unwrap(), Path::new(".")).unwrap();
        assert!(resolved.is_dir());
        assert_eq!(resolved.file_name().unwrap(), "helm-launch-test");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn folder_from_args_none_without_positional() {
        assert_eq!(folder_from_args(&[], Path::new(".")), None);
    }

    #[test]
    fn resolved_path_has_no_unc_prefix() {
        let base = std::env::temp_dir();
        let resolved = resolve_folder(".", &base).unwrap();
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    }
}
