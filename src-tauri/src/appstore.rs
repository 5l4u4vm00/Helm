// 通用的「app 狀態檔」讀寫（放在 app data dir）。
//
// 刻意保持通用的 key-value 檔案語意，不含任何 session/scrollback/journal 專屬
// 邏輯：內容對 Rust 是不透明字串，schema 與驗證全留在前端（同
// config.rs::read_agents_config 的分工），所以格式邏輯都能進 node 測試。
//
// app_data_dir 而非 app_config_dir：agents.json 是使用者可編輯的 *config*，
// 這裡放的是可重生的 *state*。macOS 上兩者是同一個資料夾，Linux/Windows 才
// 會分開，而分開是對的。
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 單檔讀取上限。手動編輯或損壞的檔案不該變成記憶體問題。
const MAX_READ_BYTES: u64 = 512 * 1024;

/// 檔名白名單。read 的參數來自「我們自己列出來的檔案」，所以 `..` 這類跳脫
/// 必須在結構上不可能，而不是靠呼叫端自律。
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir failed: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(dir)
}

fn state_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !safe_name(name) {
        return Err(format!("unsafe state file name: {name}"));
    }
    Ok(state_dir(app)?.join(name))
}

/// 檔案內容；不存在回 Ok(None)（首次啟動不是錯誤）。
#[tauri::command]
pub fn read_app_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = state_path(&app, &name)?;
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "state file too large: {name} ({} bytes)",
            meta.len()
        ));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    Ok(Some(text))
}

/// 原子替換（tmp + rename）：中斷的結束流程不可能留下截斷的檔案，最壞情況是
/// 還原上一代內容。async：同步 command 跑在 main thread，定時寫 MB 級資料會
/// 卡住 IPC。
#[tauri::command]
pub async fn write_app_file(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = state_path(&app, &name)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

/// 追加一行（自動補換行）。給 append-only 的事件日記用。
#[tauri::command]
pub async fn append_app_file(app: AppHandle, name: String, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = state_path(&app, &name)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open failed: {e}"))?;
    let line = line.trim_end_matches('\n');
    writeln!(f, "{line}").map_err(|e| format!("append failed: {e}"))?;
    Ok(())
}

/// 刪除；本來就不存在視為成功（呼叫端不必先檢查）。
#[tauri::command]
pub async fn delete_app_file(app: AppHandle, name: String) -> Result<(), String> {
    let path = state_path(&app, &name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete failed: {e}")),
    }
}

/// 以 prefix 列出狀態檔（用來清理孤兒 scrollback 檔）。
#[tauri::command]
pub fn list_app_files(app: AppHandle, prefix: String) -> Result<Vec<String>, String> {
    let dir = state_dir(&app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if safe_name(&name) && name.starts_with(&prefix) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn accepts_plain_state_file_names() {
        assert!(safe_name("sessions.json"));
        assert!(safe_name("events.jsonl"));
        assert!(safe_name("scrollback-9f8e7d.txt"));
        assert!(safe_name("a_b-c.1"));
    }

    #[test]
    fn rejects_traversal_and_separators() {
        assert!(!safe_name(""));
        assert!(!safe_name("."));
        assert!(!safe_name(".."));
        assert!(!safe_name("../secrets"));
        assert!(!safe_name("sub/dir.json"));
        assert!(!safe_name("sub\\dir.json"));
        assert!(!safe_name("~/.ssh"));
        assert!(!safe_name(&"x".repeat(129)));
    }
}
