mod appstore;
mod background;
mod config;
mod fonts;
mod git;
mod hookserver;
mod integrations;
pub mod launch;
mod notify;
mod paths;
mod pty;

use hookserver::HookServer;
use pty::PtyManager;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// Menu item labels, keyed by language. Item ids (= frontend command ids in
/// src/commands/registry.ts) never change, only the human-readable text.
struct MenuLabels {
    session: &'static str,
    new_session: &'static str,
    next_session: &'static str,
    prev_session: &'static str,
    layout: &'static str,
    split_right: &'static str,
    split_down: &'static str,
    close_pane: &'static str,
    focus_next_pane: &'static str,
    view: &'static str,
    palette: &'static str,
    toggle_files: &'static str,
    toggle_notifications: &'static str,
    toggle_sidebar: &'static str,
    toggle_theme: &'static str,
    approval: &'static str,
    approve_active: &'static str,
    reject_active: &'static str,
    approve_all: &'static str,
    reject_all: &'static str,
    help: &'static str,
    shortcuts: &'static str,
}

const LABELS_ZH_TW: MenuLabels = MenuLabels {
    session: "Session",
    new_session: "新增 Session",
    next_session: "下一個 Session",
    prev_session: "上一個 Session",
    layout: "版面",
    split_right: "向右分割",
    split_down: "向下分割",
    close_pane: "關閉 Pane",
    focus_next_pane: "焦點：下一個 Pane",
    view: "檢視",
    palette: "命令面板",
    toggle_files: "檔案變更面板",
    toggle_notifications: "通知中心",
    toggle_sidebar: "切換側欄",
    toggle_theme: "切換主題",
    approval: "審批",
    approve_active: "批准目前 Session",
    reject_active: "拒絕目前 Session",
    approve_all: "全部批准（此 Workspace）",
    reject_all: "全部拒絕（此 Workspace）",
    help: "說明",
    shortcuts: "鍵盤快捷鍵",
};

const LABELS_EN: MenuLabels = MenuLabels {
    session: "Session",
    new_session: "New Session",
    next_session: "Next Session",
    prev_session: "Previous Session",
    layout: "Layout",
    split_right: "Split Right",
    split_down: "Split Down",
    close_pane: "Close Pane",
    focus_next_pane: "Focus: Next Pane",
    view: "View",
    palette: "Command Palette",
    toggle_files: "Changed Files Panel",
    toggle_notifications: "Notifications",
    toggle_sidebar: "Toggle Sidebar",
    toggle_theme: "Toggle Theme",
    approval: "Approvals",
    approve_active: "Approve Current Session",
    reject_active: "Reject Current Session",
    approve_all: "Approve All (This Workspace)",
    reject_all: "Reject All (This Workspace)",
    help: "Help",
    shortcuts: "Keyboard Shortcuts",
};

fn labels_for(language: &str) -> &'static MenuLabels {
    match language {
        "en" => &LABELS_EN,
        _ => &LABELS_ZH_TW,
    }
}

/// 建立（或重建）應用選單：提供可發現性與滑鼠入口。實際按鍵由前端 DOM keydown
/// 處理：快捷鍵是 tmux 風格的 Ctrl+A 前綴序列（見 src/commands/prefix.ts），
/// 選單 accelerator 表達不了兩鍵序列，因此序列以文字提示附在 label 上
/// （各平台上前綴都是字面 Ctrl，提示無需分平台）。只有命令面板保留真正的
/// accelerator（⌘⇧P；webview 無焦點時仍可作用）。
/// 項目 id = 前端命令 id（見 src/commands/registry.ts）。
fn build_menu(app: &AppHandle, language: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let l = labels_for(language);
    // hint = Ctrl+A 序列的第二鍵，附在 label 後（語言無關）。
    let item = |id: &str, label: &str, hint: &str| {
        MenuItemBuilder::with_id(id, format!("{label} (Ctrl+A {hint})")).build(app)
    };

    let new_session = item("session:new", l.new_session, "c")?;
    let next_session = item("session:next", l.next_session, "n")?;
    let prev_session = item("session:prev", l.prev_session, "p")?;
    let session_menu = SubmenuBuilder::new(app, l.session)
        .items(&[&new_session, &next_session, &prev_session])
        .build()?;

    let split_right = item("layout:split-right", l.split_right, "%")?;
    let split_down = item("layout:split-down", l.split_down, "\"")?;
    let close_pane = item("layout:close-pane", l.close_pane, "x")?;
    let focus_next_pane = item("layout:focus-next-pane", l.focus_next_pane, "o")?;
    let layout_menu = SubmenuBuilder::new(app, l.layout)
        .items(&[&split_right, &split_down, &close_pane, &focus_next_pane])
        .build()?;

    let palette = MenuItemBuilder::with_id("palette:open", l.palette)
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
    let toggle_files = item("view:toggle-files", l.toggle_files, "f")?;
    let toggle_notifications = item("view:toggle-notifications", l.toggle_notifications, "b")?;
    let toggle_sidebar = item("view:toggle-sidebar", l.toggle_sidebar, "e")?;
    let toggle_theme = item("theme:toggle", l.toggle_theme, "t")?;
    let view_menu = SubmenuBuilder::new(app, l.view)
        .items(&[
            &palette,
            &toggle_files,
            &toggle_notifications,
            &toggle_sidebar,
            &toggle_theme,
        ])
        .build()?;

    let approve_active = item("approval:approve-active", l.approve_active, "y")?;
    let reject_active = item("approval:reject-active", l.reject_active, "N")?;
    let approve_all = item("approval:approve-all", l.approve_all, "Ctrl+y")?;
    let reject_all = item("approval:reject-all", l.reject_all, "Ctrl+n")?;
    let approval_menu = SubmenuBuilder::new(app, l.approval)
        .items(&[&approve_active, &reject_active, &approve_all, &reject_all])
        .build()?;

    let shortcuts = item("help:shortcuts", l.shortcuts, "?")?;
    let help_menu = SubmenuBuilder::new(app, l.help)
        .items(&[&shortcuts])
        .build()?;

    let menu = Menu::default(app)?;
    menu.append(&session_menu)?;
    menu.append(&layout_menu)?;
    menu.append(&view_menu)?;
    menu.append(&approval_menu)?;
    menu.append(&help_menu)?;
    Ok(menu)
}

/// 前端切換顯示語言時呼叫，依語言重建並套用原生應用選單。
#[tauri::command]
fn set_menu_language(app: AppHandle, language: String) -> Result<(), String> {
    let menu = build_menu(&app, &language).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS: WKWebView honors the press-and-hold accent picker
    // (ApplePressAndHoldEnabled, global default true), which suppresses key
    // repeat — holding a key must repeat in a terminal. Opt this app's
    // defaults domain out before the webview is created.
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSUserDefaults};
        NSUserDefaults::standardUserDefaults()
            .setBool_forKey(false, ns_string!("ApplePressAndHoldEnabled"));
    }
    // argv 必須在 builder 之前讀：single-instance 註冊後，第二個行程會直接退出。
    let startup_folder = launch::capture_startup_folder();
    let builder = tauri::Builder::default();
    // single-instance 只在 release build 註冊，且必須是第一個 plugin（Tauri 官方
    // 要求）：後續啟動的行程在這裡就被攔下，把資料夾轉給既有視窗（見 launch.rs）。
    //
    // debug build 刻意不註冊，讓 `npm run tauri dev` 能同時開多個視窗並排比對
    // UI（例如同一版面在不同主題／DPI 下的樣子）。正式版行為不受影響：`helm .`
    // 與 Explorer 右鍵仍然聚焦既有視窗，而不是開第二個 app。
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        launch::handle_second_instance(app, args, cwd);
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PtyManager::default())
        .manage(HookServer::default())
        .manage(startup_folder)
        .setup(|app| {
            // Hook 事件接收器：失敗不擋啟動（agent 偵測退回 viewport 掃描）。
            if let Err(e) = hookserver::start(app.handle().clone(), &app.state::<HookServer>()) {
                eprintln!("hook server disabled: {e}");
            }
            // Register the desktop-notification delegate + request authorization
            // before the app finishes launching (required on macOS; no-op elsewhere).
            notify::init(app.handle());
            let menu = build_menu(app.handle(), "zh-TW")?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                // 只轉發自家命令 id（一律含冒號的 namespace:action 形式），
                // 避免 macOS 預設選單項誤觸發；新增命名空間不必再改這裡。
                if id.contains(':') {
                    let _ = app.emit("app://shortcut", id);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            config::read_agents_config,
            appstore::read_app_file,
            appstore::write_app_file,
            appstore::append_app_file,
            appstore::delete_app_file,
            appstore::list_app_files,
            background::read_image_data_url,
            integrations::integration_status,
            integrations::install_claude_hooks,
            integrations::install_claude_statusline,
            fonts::list_monospace_fonts,
            git::git_diff_file,
            paths::dir_exists,
            launch::launch_folder,
            notify::notify_session,
            notify::notification_status,
            notify::open_notification_settings,
            set_menu_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
