// CLI agent 整合安裝：把「hook 轉發指令」合併進使用者層級的 Claude Code 設定
// （~/.claude/settings.json），讓 hook 事件流進 hookserver.rs。合併原則：
// 只新增帶 HELM_EVENT_PORT 標記的項目、冪等（已安裝就跳過）、絕不改動使用者
// 既有內容；結構不符預期（該放物件/陣列的地方是別的型別）時回錯誤而非覆蓋。
// Codex 的 config.toml 不自動改寫（TOML 合併風險大），僅回報狀態供 UI 顯示片段。
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::pty::dirs_home;

/// 安裝與否的判定標記：轉發指令必然引用這個環境變數。
const MARKER: &str = "HELM_EVENT_PORT";

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

#[cfg(not(windows))]
fn claude_hook_command() -> String {
    "[ -z \"$HELM_EVENT_PORT\" ] || curl -s -m 2 -X POST \
     \"http://127.0.0.1:$HELM_EVENT_PORT/hook?session=$HELM_SESSION_ID&source=claude-code\" \
     --data-binary @- >/dev/null 2>&1; exit 0"
        .to_string()
}

#[cfg(windows)]
fn claude_hook_command() -> String {
    // Windows 10+ 內建 curl.exe；hooks 由 cmd 執行。
    "if defined HELM_EVENT_PORT curl.exe -s -m 2 -X POST \
     \"http://127.0.0.1:%HELM_EVENT_PORT%/hook?session=%HELM_SESSION_ID%&source=claude-code\" \
     --data-binary @- >NUL 2>&1"
        .to_string()
}

fn claude_settings_path() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("no home dir")?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

fn codex_config_path() -> Result<PathBuf, String> {
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
    // 逐事件檢查而非整包搜尋 MARKER：新增事件（例如 SessionStart）時，舊安裝
    // 必須被判為「未完整安裝」，UI 才會再顯示安裝鈕把缺的補上。整包檢查會讓他們
    // 永遠停在舊的三個事件。
    let claude_hooks = CLAUDE_HOOK_EVENTS.iter().all(|event| {
        settings
            .get("hooks")
            .and_then(|h| h.get(event))
            .map(|e| e.to_string().contains(MARKER))
            .unwrap_or(false)
    });
    let claude_statusline = statusline_state(&settings);
    // 粗略文字檢查（僅供狀態顯示）：兩個 key 都設成需要的值才算開啟。
    let codex_osc9 = codex_config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|toml| {
            let has = |key: &str, val: &str| {
                toml.lines().any(|l| {
                    let l = l.trim();
                    !l.starts_with('#') && l.starts_with(key) && l.contains(val)
                })
            };
            has("notification_method", "osc9") && has("notification_condition", "always")
        })
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
        if entries.to_string().contains(MARKER) {
            continue; // 已安裝
        }
        let entries = entries
            .as_array_mut()
            .ok_or_else(|| format!("settings.json 的 hooks.{event} 不是陣列"))?;
        entries.push(json!({ "hooks": [{ "type": "command", "command": command }] }));
        changed = true;
    }
    Ok(changed)
}

/// 把轉發 hook 合併進 ~/.claude/settings.json 的各個事件。冪等：
/// 事件底下已有帶標記的項目就跳過，所以舊安裝重跑一次只會補上新增的事件。
#[tauri::command]
pub fn install_claude_hooks() -> Result<(), String> {
    let path = claude_settings_path()?;
    let mut settings = read_json(&path)?;
    if merge_claude_hooks(&mut settings, &claude_hook_command())? {
        write_json(&path, &settings)?;
    }
    Ok(())
}

/// statusline 轉發腳本內容：把 stdin 的 JSON 轉給 Helm 後，印出精簡狀態列
/// （模型 / 成本 / 剩餘 context；sed 對欄位做 best-effort 擷取）。
#[cfg(not(windows))]
const STATUSLINE_SCRIPT: &str = r#"#!/bin/sh
# Helm statusline forwarder: relay Claude Code's statusline JSON to Helm
# (cost / context usage), then print a compact status line.
json=$(cat)
if [ -n "$HELM_EVENT_PORT" ]; then
  printf '%s' "$json" | curl -s -m 2 -X POST \
    "http://127.0.0.1:$HELM_EVENT_PORT/hook?session=$HELM_SESSION_ID&source=claude-code-statusline" \
    --data-binary @- >/dev/null 2>&1
fi
model=$(printf '%s' "$json" | sed -n 's/.*"display_name" *: *"\([^"]*\)".*/\1/p')
cost=$(printf '%s' "$json" | sed -n 's/.*"total_cost_usd" *: *\([0-9.]*\).*/\1/p')
left=$(printf '%s' "$json" | sed -n 's/.*"remaining_percentage" *: *\([0-9.]*\).*/\1/p')
line="${model:-Claude}"
[ -n "$cost" ] && line="$line \$$cost"
[ -n "$left" ] && line="$line ${left}% left"
printf '%s' "$line"
"#;

/// 安裝 statusline 轉發（僅在使用者尚未設定 statusline 時）：腳本寫進 app
/// config dir，settings.json 指過去。Windows 版尚未支援（缺可移植的 shell）。
#[tauri::command]
pub fn install_claude_statusline(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        return Err("Windows 尚未支援 statusline 整合".into());
    }
    #[cfg(not(windows))]
    {
        let path = claude_settings_path()?;
        let mut settings = read_json(&path)?;
        // "helm" 不提前返回：照樣重寫，修復舊版未加引號的安裝。
        if statusline_state(&settings) == "other" {
            return Err("已有自訂 statusline，請手動整合".into());
        }
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("app_config_dir failed: {e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
        let script = dir.join("helm-statusline.sh");
        std::fs::write(&script, STATUSLINE_SCRIPT).map_err(|e| format!("write failed: {e}"))?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod failed: {e}"))?;
        }
        let root = settings
            .as_object_mut()
            .ok_or("settings.json 頂層不是物件")?;
        root.insert(
            "statusLine".into(),
            // Claude Code 以 shell 執行這個字串；macOS 的 app config dir 含空格
            // （"Application Support"），必須加引號否則在空格處被切斷（exit 127）。
            json!({
                "type": "command",
                "command": format!("\"{}\"", script.to_string_lossy()),
            }),
        );
        write_json(&path, &settings)
    }
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
