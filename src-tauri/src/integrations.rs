// CLI agent 整合安裝：把「hook 轉發指令」合併進使用者層級的 Claude Code 設定
// （~/.claude/settings.json），讓 hook 事件流進 hookserver.rs。合併原則：
// 只新增帶 HELM_EVENT_PORT 標記的項目、冪等（已安裝就跳過）、絕不改動使用者
// 既有內容；結構不符預期（該放物件/陣列的地方是別的型別）時回錯誤而非覆蓋。
// Codex 的 config.toml 不自動改寫（TOML 合併風險大），僅回報狀態供 UI 顯示片段。
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::pty::dirs_home;

/// 安裝與否的判定標記：Unix 的 inline 轉發指令必然引用這個環境變數。
const MARKER: &str = "HELM_EVENT_PORT";

/// Windows 的判定標記：指令是「powershell -File <腳本>」，環境變數只出現在
/// 腳本內容裡而不在 settings.json，故改認腳本檔名。
const MARKER_WIN: &str = "helm-hook.ps1";

/// 舊版 Windows 用 cmd.exe 語法寫入的轉發項目（含 %HELM_EVENT_PORT%）。實際上
/// Claude Code 在 Windows 用 Git Bash（沒裝才 PowerShell）執行 command，cmd 從
/// 不參與，所以那些項目兩種 host 下都跑不起來；又因含 MARKER 而被誤判為「已安裝」
/// 永遠跳過重裝。合併前先移除，讓重新安裝能真正修好。
const LEGACY_CMD_MARKER: &str = "%HELM_EVENT_PORT%";

/// 要安裝的 hook 事件（PermissionRequest = 審批、Stop = 回合結束、
/// PostToolUse = 工具完成/檔案變更、SessionStart = 一開場就拿到 agent 自己的
/// session_id，供重啟後接續對話 —— 前三者也帶 session_id，但 SessionStart 讓
/// 「還沒動過任何工具就重啟」的 session 也能接續）。
const CLAUDE_HOOK_EVENTS: [&str; 4] = [
    "PermissionRequest",
    "Stop",
    "PostToolUse",
    "SessionStart",
];

/// 轉發腳本內容。腳本放獨立檔案而非 Rust 字串常數：review 時看得到語法上色，
/// 且 CI 能在 windows runner 上用 [ScriptBlock]::Create 做語法檢查。
const STATUSLINE_SCRIPT_SH: &str = include_str!("../scripts/helm-statusline.sh");
const STATUSLINE_SCRIPT_PS1: &str = include_str!("../scripts/helm-statusline.ps1");
const HOOK_SCRIPT_PS1: &str = include_str!("../scripts/helm-hook.ps1");

/// 指令字串是否為 Helm 裝的（兩個平台的標記都算）。
fn has_helm_marker(s: &str) -> bool {
    s.contains(MARKER) || s.contains(MARKER_WIN)
}

/// 給 Claude Code 的 command 字串用的路徑。Windows 轉正斜線：官方文件明言
/// Git Bash 會把未加引號的反斜線當轉義字元吃掉，且「失敗時不會有可見錯誤」。
/// 一律加引號：macOS 的 "Application Support" 與 Windows 使用者名稱都可能含空格。
fn command_path_for(windows: bool, p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = if windows {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    };
    format!("\"{s}\"")
}

/// 以 powershell 執行腳本的 command 字串。-ExecutionPolicy Bypass 是必要的：
/// 預設的 Restricted 原則會擋未簽章的 .ps1。
fn powershell_command(script: &Path) -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File {}",
        command_path_for(true, script)
    )
}

/// hook 轉發指令。純函式且平台以參數傳入，讓 Linux CI 也能編譯並測試 Windows
/// 變體（沿用 pty.rs default_shell_command 的 cfg!(windows) 慣例）。
/// Unix 維持單行 inline 指令（不落地腳本檔）；Windows 需要實體 .ps1，因為
/// command 必須是「執行檔 + 參數」形式才能同時被 Git Bash 與 PowerShell 正確執行。
fn hook_command_for(windows: bool, script: Option<&Path>) -> String {
    match (windows, script) {
        (true, Some(script)) => powershell_command(script),
        _ => "[ -z \"$HELM_EVENT_PORT\" ] || curl -s -m 2 -X POST \
              \"http://127.0.0.1:$HELM_EVENT_PORT/hook?session=$HELM_SESSION_ID&source=claude-code\" \
              --data-binary @- >/dev/null 2>&1; exit 0"
            .to_string(),
    }
}

/// statusline 的 command 字串。Unix 是裸的引號路徑（Claude Code 直接以 shell
/// 執行該檔）；Windows 走 powershell -File。
fn statusline_command_for(windows: bool, script: &Path) -> String {
    if windows {
        powershell_command(script)
    } else {
        command_path_for(false, script)
    }
}

/// 腳本檔名（副檔名決定於平台）。
fn script_file_name(windows: bool, stem: &str) -> String {
    let ext = if windows { "ps1" } else { "sh" };
    format!("{stem}.{ext}")
}

fn statusline_script(windows: bool) -> &'static str {
    if windows {
        STATUSLINE_SCRIPT_PS1
    } else {
        STATUSLINE_SCRIPT_SH
    }
}

/// hook 腳本內容；Unix 回 None（指令 inline，不落地檔案）。
fn hook_script(windows: bool) -> Option<&'static str> {
    if windows {
        Some(HOOK_SCRIPT_PS1)
    } else {
        None
    }
}

fn claude_settings_path() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("no home dir")?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

/// Codex 設定檔路徑。CODEX_HOME 指向「設定目錄」（內含 config.toml）而非檔案
/// 本身，這是 Codex 自己的語義（已對 0.146.0 實測）。空字串要濾掉，否則
/// export 成空值會解析成相對於 Helm cwd 的 ./config.toml。
fn codex_config_path() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var("CODEX_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(PathBuf::from(dir).join("config.toml"));
    }
    let home = dirs_home().ok_or("no home dir")?;
    Ok(PathBuf::from(home).join(".codex").join("config.toml"))
}

/// 讀 JSON 設定檔；不存在視為空物件。
fn read_json(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let content = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("{} 不是有效 JSON: {e}", path.display()))
}

fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("write failed: {e}"))
}

/// notification_method 是否為 osc9。實測 Codex 0.146.0 接受兩種合法寫法：
/// 字串 `"osc9"`，以及 externally-tagged 的 unit variant `{ osc9 = {} }`
/// （`{ type = "osc9" }` 會被拒，key 本身就是變體名）。陣列形式被 Codex 拒絕
/// （`invalid type: sequence`），故不接受。比對用完全相等，`"not-osc9"` 不算；
/// 不做大小寫折疊——TOML value 大小寫敏感，且 Codex 認的是小寫。
fn method_is_osc9(v: Option<&toml::Value>) -> bool {
    match v {
        Some(toml::Value::String(s)) => s == "osc9",
        Some(toml::Value::Table(t)) => t.len() == 1 && t.contains_key("osc9"),
        _ => false,
    }
}

/// Codex 是否已設好 Helm 需要的 OSC 9 通知（純函式，可單元測試）。
///
/// 真正解析 TOML 而非逐行字串比對：原本的行掃描不看目前在哪個 [table]，又用
/// starts_with 比對 key、contains 比對 value、只跳過整行註解，於是
/// `notification_method_fallback`、`"not-osc9"`、行尾註解 `# osc9`、以及放在
/// 任何其他 table 下的 key 都會誤判「已設定」（假綠燈：Helm 說好了但通知永遠
/// 不來，最難除錯）；反過來 dotted key、inline table、map 形式這些合法寫法會
/// 誤判「未設定」，讓已正確設定的人被提示橫幅永久打擾。
///
/// 解析後 dotted key / [tui] / inline table 三種寫法是同一棵樹，取 tui 子表即
/// 可一次涵蓋。TOML 壞掉視為未設定：不 panic，UI 只會顯示可複製的片段。
fn codex_osc9_enabled(toml_text: &str) -> bool {
    let Ok(root) = toml_text.parse::<toml::Table>() else {
        return false;
    };
    let Some(tui) = root.get("tui").and_then(toml::Value::as_table) else {
        return false;
    };
    // condition 必須是 always：Helm 需要在自己視窗有焦點時也收到訊號（焦點抑制
    // 由 shouldDesktopNotify 自己處理），unfocused 對 Helm 不夠用。
    method_is_osc9(tui.get("notification_method"))
        && tui
            .get("notification_condition")
            .and_then(toml::Value::as_str)
            == Some("always")
}

/// statusline 的狀態："none"（未設）/"helm"（我們裝的）/"other"（使用者自己的）。
fn statusline_state(settings: &Value) -> &'static str {
    match settings.get("statusLine") {
        None | Some(Value::Null) => "none",
        Some(v) if v.to_string().contains("helm-statusline") => "helm",
        Some(_) => "other",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    claude_hooks: bool,
    claude_statusline: &'static str,
    codex_osc9: bool,
}

/// 回報各整合項的安裝狀態，供設定頁顯示。讀檔失敗視為未安裝（UI 會提供安裝鈕，
/// 真正的錯誤在安裝時回報）。
#[tauri::command]
pub fn integration_status() -> IntegrationStatus {
    let settings = claude_settings_path()
        .and_then(|p| read_json(&p))
        .unwrap_or(json!({}));
    // 逐事件檢查而非整包搜尋標記：新增事件（例如 SessionStart）時，舊安裝
    // 必須被判為「未完整安裝」，UI 才會再顯示安裝鈕把缺的補上。整包檢查會讓他們
    // 永遠停在舊的三個事件。用 has_helm_marker 而非 MARKER：Windows 安裝寫的是
    // helm-hook.ps1 指令，裡面根本不含 HELM_EVENT_PORT。
    let claude_hooks = CLAUDE_HOOK_EVENTS.iter().all(|event| {
        settings
            .get("hooks")
            .and_then(|h| h.get(event))
            .map(|e| has_helm_marker(&e.to_string()))
            .unwrap_or(false)
    });
    let claude_statusline = statusline_state(&settings);
    // 只讀不寫；讀不到檔或解析失敗都視為未設定（UI 會給可複製的片段）。
    let codex_osc9 = codex_config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| codex_osc9_enabled(&t))
        .unwrap_or(false);
    IntegrationStatus {
        claude_hooks,
        claude_statusline,
        codex_osc9,
    }
}

/// 合併轉發 hook 到 settings JSON（純函式，可單元測試）。回傳是否有變更。
fn merge_claude_hooks(settings: &mut Value, command: &str) -> Result<bool, String> {
    let root = settings
        .as_object_mut()
        .ok_or("settings.json 頂層不是物件")?;
    let hooks = root.entry("hooks").or_insert(json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("settings.json 的 hooks 不是物件")?;
    let mut changed = false;
    for event in CLAUDE_HOOK_EVENTS {
        let entries = hooks.entry(event).or_insert(json!([]));
        let entries = entries
            .as_array_mut()
            .ok_or_else(|| format!("settings.json 的 hooks.{event} 不是陣列"))?;
        // 先移除舊版 cmd.exe 語法的壞項目，再做冪等檢查——順序反了的話「只有
        // legacy 項目」的事件會被當成已安裝而跳過，永遠修不好。只挑含 %VAR% 的：
        // Unix 與新 PowerShell 形式都不可能含 %…%，故不會誤刪使用者自己的 hook。
        let before = entries.len();
        entries.retain(|e| !e.to_string().contains(LEGACY_CMD_MARKER));
        if entries.len() != before {
            changed = true;
        }
        if entries.iter().any(|e| has_helm_marker(&e.to_string())) {
            continue; // 已安裝
        }
        entries.push(json!({ "hooks": [{ "type": "command", "command": command }] }));
        changed = true;
    }
    Ok(changed)
}

/// 把腳本寫進 app config dir 並回傳路徑。每次安裝都重寫，讓舊版使用者按一下
/// 就拿到更新的腳本。
fn write_script(app: &AppHandle, stem: &str, body: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir failed: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let script = dir.join(script_file_name(cfg!(windows), stem));
    std::fs::write(&script, body).map_err(|e| format!("write failed: {e}"))?;
    // Unix 需要執行位元；Windows 以 powershell -File 執行，不看執行位元，且
    // PermissionsExt 在 Windows 根本不存在，故必須 cfg 隔離。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod failed: {e}"))?;
    }
    Ok(script)
}

/// 把轉發 hook 合併進 ~/.claude/settings.json 的各個事件。冪等：
/// 事件底下已有帶標記的項目就跳過，所以舊安裝重跑一次只會補上新增的事件。
#[tauri::command]
pub fn install_claude_hooks(app: AppHandle) -> Result<(), String> {
    // Windows 需要一支實體 .ps1；Unix 的指令是 inline 的，不落地檔案。
    let script = match hook_script(cfg!(windows)) {
        Some(body) => Some(write_script(&app, "helm-hook", body)?),
        None => None,
    };
    let path = claude_settings_path()?;
    let mut settings = read_json(&path)?;
    let command = hook_command_for(cfg!(windows), script.as_deref());
    if merge_claude_hooks(&mut settings, &command)? {
        write_json(&path, &settings)?;
    }
    Ok(())
}

/// 安裝 statusline 轉發（僅在使用者尚未設定 statusline 時）：腳本寫進 app
/// config dir，settings.json 指過去。
#[tauri::command]
pub fn install_claude_statusline(app: AppHandle) -> Result<(), String> {
    let path = claude_settings_path()?;
    let mut settings = read_json(&path)?;
    // "helm" 不提前返回：照樣重寫，修復舊版未加引號的安裝。
    if statusline_state(&settings) == "other" {
        return Err("已有自訂 statusline，請手動整合".into());
    }
    let script = write_script(&app, "helm-statusline", statusline_script(cfg!(windows)))?;
    let root = settings
        .as_object_mut()
        .ok_or("settings.json 頂層不是物件")?;
    root.insert(
        "statusLine".into(),
        json!({
            "type": "command",
            "command": statusline_command_for(cfg!(windows), &script),
        }),
    );
    write_json(&path, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "curl http://127.0.0.1:$HELM_EVENT_PORT/hook";

    // 空設定：建立 hooks 物件與三個事件，各一個轉發項目。
    #[test]
    fn merge_into_empty_settings() {
        let mut s = json!({});
        assert!(merge_claude_hooks(&mut s, CMD).unwrap());
        for event in CLAUDE_HOOK_EVENTS {
            let entries = s["hooks"][event].as_array().unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0]["hooks"][0]["command"], CMD);
        }
    }

    // 使用者既有內容（其他 hook、其他頂層 key）原封不動，只追加我們的項目。
    #[test]
    fn merge_preserves_existing_entries() {
        let mut s = json!({
            "model": "opus",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "afplay done.wav" }] }]
            }
        });
        assert!(merge_claude_hooks(&mut s, CMD).unwrap());
        assert_eq!(s["model"], "opus");
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "afplay done.wav");
        assert!(stop[1]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(MARKER));
    }

    // 冪等：再跑一次不再變更。
    #[test]
    fn merge_is_idempotent() {
        let mut s = json!({});
        assert!(merge_claude_hooks(&mut s, CMD).unwrap());
        assert!(!merge_claude_hooks(&mut s, CMD).unwrap());
        for event in CLAUDE_HOOK_EVENTS {
            assert_eq!(s["hooks"][event].as_array().unwrap().len(), 1);
        }
    }

    // 結構不符（hooks 不是物件 / 事件不是陣列）→ 回錯誤，不覆蓋。
    #[test]
    fn merge_rejects_unexpected_shapes() {
        let mut s = json!({ "hooks": "oops" });
        assert!(merge_claude_hooks(&mut s, CMD).is_err());
        let mut s = json!({ "hooks": { "Stop": {} } });
        assert!(merge_claude_hooks(&mut s, CMD).is_err());
    }

    // ---- 指令組裝（兩個平台的變體都在任何 host 上可測）----

    // Unix 指令逐字鎖定：這是重構後不得退化的回歸鎖。
    #[test]
    fn hook_command_unix_is_unchanged() {
        assert_eq!(
            hook_command_for(false, None),
            "[ -z \"$HELM_EVENT_PORT\" ] || curl -s -m 2 -X POST \
             \"http://127.0.0.1:$HELM_EVENT_PORT/hook?session=$HELM_SESSION_ID&source=claude-code\" \
             --data-binary @- >/dev/null 2>&1; exit 0"
        );
    }

    // Windows 指令必須是「執行檔 + 參數」，且完全不含反斜線（Git Bash 會靜默
    // 吃掉）與 %…%（確認 cmd.exe 語法沒殘留）。
    #[test]
    fn hook_command_windows_is_executable_plus_args() {
        let p = PathBuf::from("C:\\Users\\A B\\AppData\\Roaming\\com.x.helm\\helm-hook.ps1");
        let cmd = hook_command_for(true, Some(&p));
        assert!(cmd.starts_with("powershell -NoProfile -ExecutionPolicy Bypass -File "));
        assert!(!cmd.contains('\\'), "Git Bash 會吃掉反斜線: {cmd}");
        assert!(!cmd.contains('%'), "cmd.exe 語法殘留: {cmd}");
        assert!(cmd.contains("\"C:/Users/A B/AppData/Roaming/com.x.helm/helm-hook.ps1\""));
    }

    // 這條就是原本能抓到「Windows hook 誤報已安裝」的測試。
    #[test]
    fn hook_command_windows_carries_install_marker() {
        let p = PathBuf::from("C:\\x\\helm-hook.ps1");
        assert!(has_helm_marker(&hook_command_for(true, Some(&p))));
        assert!(has_helm_marker(&hook_command_for(false, None)));
    }

    // Unix statusline 是裸的引號路徑——確認 powershell 前綴沒漏過去。
    #[test]
    fn statusline_command_unix_is_bare_quoted_path() {
        let p = PathBuf::from("/Users/x/Library/Application Support/com.x.helm/helm-statusline.sh");
        let cmd = statusline_command_for(false, &p);
        assert_eq!(
            cmd,
            "\"/Users/x/Library/Application Support/com.x.helm/helm-statusline.sh\""
        );
        assert!(!cmd.contains("powershell"));
    }

    // .ps1 包在 powershell 指令裡，仍要被認成 Helm 裝的（statusline_state 比對
    // 檔名子字串，與副檔名無關）。
    #[test]
    fn statusline_command_windows_still_detected_as_helm() {
        let p = PathBuf::from("C:\\Users\\A B\\AppData\\Roaming\\com.x.helm\\helm-statusline.ps1");
        let s = json!({ "statusLine": {
            "type": "command",
            "command": statusline_command_for(true, &p),
        }});
        assert_eq!(statusline_state(&s), "helm");
    }

    #[test]
    fn script_file_name_per_platform() {
        assert_eq!(script_file_name(true, "helm-hook"), "helm-hook.ps1");
        assert_eq!(
            script_file_name(false, "helm-statusline"),
            "helm-statusline.sh"
        );
    }

    // ---- 舊版壞項目的清除 ----

    // 舊版 cmd.exe 指令要被移除並換成新的，而非因含 MARKER 被判「已安裝」跳過。
    #[test]
    fn merge_removes_legacy_cmd_hook() {
        let legacy = "if defined HELM_EVENT_PORT curl.exe -s -m 2 -X POST \
                      \"http://127.0.0.1:%HELM_EVENT_PORT%/hook?session=%HELM_SESSION_ID%\" \
                      --data-binary @- >NUL 2>&1";
        let mut s = json!({ "hooks": { "Stop": [
            { "hooks": [{ "type": "command", "command": legacy }] }
        ]}});
        assert!(merge_claude_hooks(&mut s, CMD).unwrap());
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1, "舊項目應被移除、只剩新的");
        assert_eq!(stop[0]["hooks"][0]["command"], CMD);
        assert!(!s.to_string().contains(LEGACY_CMD_MARKER));
    }

    // 清除不可過貪：只刪含 %VAR% 的 Helm 舊項目，使用者自己的 hook 要留著。
    #[test]
    fn merge_preserves_user_hooks_when_removing_legacy() {
        let legacy = "if defined HELM_EVENT_PORT curl.exe %HELM_EVENT_PORT% >NUL";
        let mut s = json!({ "hooks": { "Stop": [
            { "hooks": [{ "type": "command", "command": "afplay done.wav" }] },
            { "hooks": [{ "type": "command", "command": legacy }] }
        ]}});
        assert!(merge_claude_hooks(&mut s, CMD).unwrap());
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "afplay done.wav");
        assert_eq!(stop[1]["hooks"][0]["command"], CMD);
    }

    // ---- 腳本內容不變量（PowerShell 語法本身由 CI 的 windows runner 檢查）----

    #[test]
    fn ps1_scripts_hold_their_invariants() {
        for (name, body) in [
            ("helm-hook.ps1", HOOK_SCRIPT_PS1),
            ("helm-statusline.ps1", STATUSLINE_SCRIPT_PS1),
        ] {
            assert!(body.trim_end().ends_with("exit 0"), "{name} 必須無條件成功");
            // curl.exe 而非 Invoke-RestMethod：後者會 URL-encode JSON / 加 BOM。
            // 只看非註解行——註解本身要能解釋為何不用 Invoke-*。
            let code: String = body
                .lines()
                .filter(|l| !l.trim_start().starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(code.contains("curl.exe"), "{name} 應用 curl.exe");
            assert!(
                !code.contains("Invoke-RestMethod") && !code.contains("Invoke-WebRequest"),
                "{name} 不該用 Invoke-*"
            );
            // -File 啟動的腳本要讀真實 stdin，$input 只在 pipeline 內有值。
            assert!(
                body.contains("[Console]::In.ReadToEnd()"),
                "{name} 應讀真實 stdin"
            );
            // PS 5.1 的 $OutputEncoding 預設 ASCII，會打爛 CJK 路徑。
            assert!(body.contains("UTF8Encoding"), "{name} 必須設 UTF-8 編碼");
            assert!(!body.starts_with('\u{feff}'), "{name} 不該有 BOM");
        }
        // 對應 Unix 版的 printf '%s'：不加結尾換行。
        assert!(STATUSLINE_SCRIPT_PS1.contains("-NoNewline"));
        // 官方 schema 沒有這個欄位（真實路徑是 current_usage.input_tokens）。
        assert!(!STATUSLINE_SCRIPT_PS1.contains("total_input_tokens"));
    }

    // ---- codex OSC 9 偵測 ----

    /// 貼近使用者真實 config.toml 的骨架：多個 section、[tui] 之後還有子表。
    /// tui_body 放 [tui] 那段。
    fn codex_config(tui_body: &str) -> String {
        format!(
            "model = \"gpt-5\"\n\
             \n\
             [projects.\"/home/u/proj\"]\n\
             trust_level = \"trusted\"\n\
             \n\
             [notice.model_migrations]\n\
             \"gpt-5.2\" = \"gpt-5.3\"\n\
             \n\
             {tui_body}\n"
        )
    }

    // 使用者真實的寫法：[tui] 下兩個 key，且後面還有 [tui.*] 子表。
    #[test]
    fn codex_osc9_detects_plain_tui_table() {
        let s = codex_config(
            "[tui]\n\
             notification_method = \"osc9\"\n\
             notification_condition = \"always\"\n\
             \n\
             [tui.model_availability_nux]\n\
             \"gpt-5.5\" = 4\n",
        );
        assert!(codex_osc9_enabled(&s));
    }

    // 關鍵修正：key 放在別的 table（或 document root）都不算——舊的行掃描會誤判。
    #[test]
    fn codex_osc9_ignores_keys_in_other_tables() {
        let wrong_table = codex_config(
            "[mcp_servers.foo]\n\
             notification_method = \"osc9\"\n\
             notification_condition = \"always\"\n",
        );
        assert!(!codex_osc9_enabled(&wrong_table));
        let root = "notification_method = \"osc9\"\nnotification_condition = \"always\"\n";
        assert!(!codex_osc9_enabled(root));
    }

    // dotted key 是合法 TOML，解析後與 [tui] 同一棵樹 → 必須算已設定。
    // 注意 dotted key 屬於「前面最近的 table」，故必須放在任何 [section] 之前
    // （不能用 codex_config，否則會變成 notice.model_migrations.tui）。
    #[test]
    fn codex_osc9_accepts_dotted_keys() {
        let s = "model = \"gpt-5\"\n\
                 tui.notification_method = \"osc9\"\n\
                 tui.notification_condition = \"always\"\n\
                 \n\
                 [projects.\"/home/u/proj\"]\n\
                 trust_level = \"trusted\"\n";
        assert!(codex_osc9_enabled(s));
    }

    // inline table 同理，且同樣要在 [section] 之前。也不能再帶 [tui.*] 子表
    // ——為 inline table 定義子表是非法 TOML，會讓測試因錯誤的原因而通過。
    #[test]
    fn codex_osc9_accepts_inline_table() {
        let s = "tui = { notification_method = \"osc9\", notification_condition = \"always\" }\n\
                 \n\
                 [projects.\"/home/u/proj\"]\n\
                 trust_level = \"trusted\"\n";
        assert!(codex_osc9_enabled(s));
    }

    // 實測 Codex 接受 externally-tagged 的 unit variant 寫法。
    #[test]
    fn codex_osc9_accepts_method_as_tagged_map() {
        let s = codex_config(
            "[tui]\n\
             notification_method = { osc9 = {} }\n\
             notification_condition = \"always\"\n",
        );
        assert!(codex_osc9_enabled(&s));
    }

    // 實測 Codex 拒絕陣列（invalid type: sequence），故我們也不能算已設定。
    #[test]
    fn codex_osc9_rejects_method_array() {
        let s = codex_config(
            "[tui]\n\
             notification_method = [\"osc9\"]\n\
             notification_condition = \"always\"\n",
        );
        assert!(!codex_osc9_enabled(&s));
    }

    // 舊的 starts_with / contains 比對會把這些全放過。
    #[test]
    fn codex_osc9_rejects_lookalike_values_and_keys() {
        let similar = codex_config(
            "[tui]\n\
             notification_method = \"not-osc9\"\n\
             notification_condition = \"always\"\n",
        );
        assert!(!codex_osc9_enabled(&similar));
        let prefixed = codex_config(
            "[tui]\n\
             notification_method_fallback = \"osc9\"\n\
             notification_condition = \"always\"\n",
        );
        assert!(!codex_osc9_enabled(&prefixed));
        // 行尾註解供出子字串——舊檢查只跳過整行註解。
        let comment = codex_config(
            "[tui]\n\
             notification_method = \"auto\" # osc9 試過會壞\n\
             notification_condition = \"always\"\n",
        );
        assert!(!codex_osc9_enabled(&comment));
    }

    // condition 必須是 always；unfocused 對 Helm 不夠（見 codex_osc9_enabled 註解）。
    #[test]
    fn codex_osc9_requires_condition_always() {
        let s = codex_config(
            "[tui]\n\
             notification_method = \"osc9\"\n\
             notification_condition = \"unfocused\"\n",
        );
        assert!(!codex_osc9_enabled(&s));
    }

    // 缺任一 key 都不算。
    #[test]
    fn codex_osc9_requires_both_keys() {
        let no_cond = codex_config("[tui]\nnotification_method = \"osc9\"\n");
        assert!(!codex_osc9_enabled(&no_cond));
        let no_method = codex_config("[tui]\nnotification_condition = \"always\"\n");
        assert!(!codex_osc9_enabled(&no_method));
    }

    // 壞 TOML / 空文件 → false，且不得 panic。
    #[test]
    fn codex_osc9_handles_malformed_input() {
        assert!(!codex_osc9_enabled("[tui\nnotification_method = "));
        assert!(!codex_osc9_enabled(""));
        assert!(!codex_osc9_enabled("這不是 TOML"));
    }

    // statusline 偵測：quoted / 未加引號的舊安裝都判為 "helm"；其他 command 判 "other"。
    #[test]
    fn statusline_state_detects_helm_quoted_or_not() {
        let quoted = json!({ "statusLine": {
            "type": "command",
            "command": "\"/Users/x/Library/Application Support/com.x.helm/helm-statusline.sh\""
        }});
        assert_eq!(statusline_state(&quoted), "helm");
        let unquoted = json!({ "statusLine": {
            "type": "command",
            "command": "/Users/x/Library/Application Support/com.x.helm/helm-statusline.sh"
        }});
        assert_eq!(statusline_state(&unquoted), "helm");
        assert_eq!(statusline_state(&json!({})), "none");
        let other = json!({ "statusLine": { "type": "command", "command": "my-statusline" } });
        assert_eq!(statusline_state(&other), "other");
    }
}
