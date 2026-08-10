// PTY 管理：每個 session 一條 PTY。
// 設計為多 session（id -> PtySession 的 map），Phase 1 可直接沿用。
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

/// 單一 PTY session 在 Rust 端持有的資源。
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    // Per-session 鎖：PTY master 的 write 在子行程不排空輸入時會阻塞，
    // 不能在全域 map 鎖內執行，否則一個 session 卡住所有指令。
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    // 保留 child 以便日後查詢/終止；drop 時會嘗試結束子行程。
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// 全域 PTY 管理器，作為 Tauri managed state。
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// 取得 session map 的鎖；容忍 poisoning（持鎖執行緒 panic 不該永久癱瘓
/// 所有 PTY 指令，map 本身沒有需要跨語句維護的不變量）。
fn lock_sessions(
    sessions: &Mutex<HashMap<String, PtySession>>,
) -> MutexGuard<'_, HashMap<String, PtySession>> {
    sessions.lock().unwrap_or_else(|e| e.into_inner())
}

/// 終止並回收子行程（kill 後 wait 避免殭屍；已結束的 child kill 失敗無害）。
fn reap(mut session: PtySession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
}

#[derive(Deserialize)]
pub struct SpawnOptions {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    /// 啟動的 shell / 指令；None 則用使用者預設 shell。
    pub shell: Option<String>,
    /// 工作目錄；None 則用使用者 home。
    pub cwd: Option<String>,
    /// Workspace recipe 帶來的額外環境變數（見 workspaceGroups.ts）。
    /// Helm 自己的變數不可被覆寫 —— 前端已濾過一次，這裡再濾一次，
    /// 因為 hook 路由的正確性不該只靠呼叫端自律。
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// PTY 環境變數中屬於 Helm 自己、recipe 不得覆寫的 key。
/// 與前端 RESERVED_ENV_KEYS 對應，兩邊都擋。
const RESERVED_ENV_KEYS: [&str; 3] = ["HELM_SESSION_ID", "HELM_EVENT_PORT", "TERM"];

/// key 是否為 Helm 保留。Windows 的環境變數區塊不分大小寫，故該平台以
/// 不分大小寫比對 —— 否則 `helm_session_id` 會繞過檢查再覆蓋掉真正的那個。
fn is_reserved_env_key(key: &str) -> bool {
    if cfg!(windows) {
        RESERVED_ENV_KEYS
            .iter()
            .any(|k| k.eq_ignore_ascii_case(key))
    } else {
        RESERVED_ENV_KEYS.contains(&key)
    }
}

/// 環境變數 key 的合法字元集（與前端 isValidEnvKey 相同）。
/// 帶 `=` 或空白的 key 在任何 shell 都無法 export，擋在這裡而不是讓它
/// 在子行程裡無聲失敗。
fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 在 PATH 中尋找可執行檔（Windows 預設 shell 偵測用）。
fn find_on_path(exe: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(exe).is_file())
}

/// 預設 shell（程式 + 參數）。解析順序：HELM_SHELL → SHELL → 平台預設。
/// Windows 平台預設：pwsh（PowerShell 7）優先，否則 Windows PowerShell，
/// 並帶 -NoLogo 隱藏版權橫幅；Unix 預設 /bin/zsh。
fn default_shell_command() -> (String, Vec<String>) {
    for var in ["HELM_SHELL", "SHELL"] {
        if let Ok(shell) = std::env::var(var) {
            if !shell.is_empty() {
                return (shell, vec![]);
            }
        }
    }
    if cfg!(windows) {
        let ps = if find_on_path("pwsh.exe") {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        return (ps.to_string(), vec!["-NoLogo".to_string()]);
    }
    ("/bin/zsh".to_string(), vec![])
}

/// 建立一條新的 PTY 並啟動 shell，同時開一條讀取執行緒把輸出串流到前端。
/// Output goes through the invoke Channel as raw bytes (no base64, no JSON,
/// ordered delivery); only the once-per-lifetime exit stays on an event
/// (`pty://exit/<id>`).
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    options: SpawnOptions,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.max(1),
            cols: options.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // 使用者指定的 shell 視為單一程式（無參數）；未指定才用平台預設（可含參數）。
    let (program, args) = match options.shell {
        Some(shell) => (shell, vec![]),
        None => default_shell_command(),
    };
    let mut cmd = CommandBuilder::new(program);
    cmd.args(&args);
    // Workspace recipe 的環境變數先套用，Helm 自己的隨後覆蓋上去。
    // 保留 key 已在上面濾掉，此處的順序是第二道保險：即使濾網有漏，
    // 後寫的 HELM_SESSION_ID / TERM 仍然贏。
    if let Some(env) = &options.env {
        for (key, value) in env {
            if is_valid_env_key(key) && !is_reserved_env_key(key) {
                cmd.env(key, value);
            }
        }
    }
    cmd.env("TERM", "xterm-256color");
    // Agent hook 整合：CLI spawn 的 hook 程序繼承這兩個變數，把事件精準對回
    // 本 session（見 hookserver.rs）。port = 0 代表 hook server 沒起來，不注入。
    cmd.env("HELM_SESSION_ID", &options.id);
    let hook_port = app.state::<crate::hookserver::HookServer>().port();
    if hook_port > 0 {
        cmd.env("HELM_EVENT_PORT", hook_port.to_string());
    }
    if let Some(cwd) = options.cwd {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    // 先取得讀取端 clone，再把 master 收進 session。
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // 讀取端 slave 已被 spawn 使用；drop 掉本地 slave handle 讓 EOF 能被偵測。
    drop(pair.slave);

    let session = PtySession {
        master: pair.master,
        writer: Arc::new(Mutex::new(writer)),
        child,
    };

    {
        let mut sessions = lock_sessions(&state.sessions);
        sessions.insert(options.id.clone(), session);
    }

    // 讀取執行緒：把 PTY 輸出串流給前端。
    // 64KB reads keep the message rate bounded under floods (the kernel PTY
    // buffer batches producer writes between reads).
    let id = options.id.clone();
    std::thread::spawn(move || {
        let exit_event = format!("pty://exit/{id}");
        let mut buf = vec![0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：子行程結束
                Ok(n) => {
                    // Send failure means the webview side is gone; stop reading.
                    if on_output
                        .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // 讀取結束（EOF / 讀取錯誤 / 前端斷線）：從 map 移除並回收子行程，
        // 否則自然結束的 shell 會留下殭屍子行程、fd 洩漏在 map 裡直到
        // pty_kill。pty_kill 先移除時這裡拿到 None，兩邊互不衝突。
        let manager = app.state::<PtyManager>();
        let session = lock_sessions(&manager.sessions).remove(&id);
        if let Some(session) = session {
            reap(session);
        }
        let _ = app.emit(&exit_event, ());
    });

    Ok(())
}

/// 將鍵盤輸入寫入指定 PTY。
#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    // map 鎖只用來取出該 session 的 writer Arc；可能阻塞的 write/flush 在
    // 鎖外執行，一個 session 的阻塞寫入不會卡住其他 session 的指令。
    let writer = {
        let sessions = lock_sessions(&state.sessions);
        Arc::clone(
            &sessions
                .get(&id)
                .ok_or_else(|| format!("no pty session: {id}"))?
                .writer,
        )
    };
    // 同 session 寫入由 writer 鎖序列化（保持鍵入順序）；容忍 poisoning，
    // 理由同 lock_sessions。
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// 調整 PTY 視窗大小（前端 fit addon 觸發）。
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = lock_sessions(&state.sessions);
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

/// 終止並移除指定 PTY session。
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    // 鎖外 kill + wait：回收不得阻塞其他 PTY 指令。
    let session = lock_sessions(&state.sessions).remove(&id);
    if let Some(session) = session {
        reap(session);
    }
    Ok(())
}

/// 使用者 home 目錄：Unix 用 HOME，Windows 用 USERPROFILE。
pub(crate) fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, PtySize};

    // 平台預設 shell 必須真的能在 PTY 裡啟動（Windows 上驗證 ConPTY + PowerShell）。
    #[test]
    fn default_shell_spawns_in_pty() {
        let (program, args) = default_shell_command();
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty should succeed");
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .unwrap_or_else(|e| panic!("default shell `{program}` should spawn: {e}"));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn home_dir_resolves() {
        assert!(dirs_home().is_some(), "HOME or USERPROFILE should exist");
    }

    #[test]
    fn env_key_validation_matches_shell_rules() {
        assert!(is_valid_env_key("PATH"));
        assert!(is_valid_env_key("_UNDERSCORE_1"));
        assert!(!is_valid_env_key(""), "empty key");
        assert!(!is_valid_env_key("1LEADING_DIGIT"));
        assert!(!is_valid_env_key("HAS SPACE"));
        assert!(!is_valid_env_key("HAS=EQUALS"));
    }

    #[test]
    fn helm_owned_env_keys_are_reserved() {
        assert!(is_reserved_env_key("HELM_SESSION_ID"));
        assert!(is_reserved_env_key("HELM_EVENT_PORT"));
        assert!(is_reserved_env_key("TERM"));
        assert!(!is_reserved_env_key("ANTHROPIC_API_KEY"));
        // Windows 環境變數不分大小寫，該平台的小寫拼法同樣要擋下。
        assert_eq!(is_reserved_env_key("helm_session_id"), cfg!(windows));
    }
}
