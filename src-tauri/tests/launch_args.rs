// 「在資料夾開啟 Helm」的參數解析整合測試：用真實的檔案系統路徑驗證
// folder_from_args，涵蓋 CLI（`helm .`）與檔案總管右鍵（絕對路徑）兩種形式。
use std::path::Path;

use helm_lib::launch::folder_from_args;

fn arg(s: &str) -> Vec<String> {
    vec![s.to_string()]
}

#[test]
fn dot_resolves_to_the_launch_directory() {
    let dir = std::env::temp_dir().join("helm-args-dot");
    std::fs::create_dir_all(&dir).unwrap();

    let got = folder_from_args(&arg("."), &dir).expect("`helm .` resolves");
    // canonicalize 兩邊再比，temp_dir 在 Windows 上可能是 8.3 短檔名。
    let want = std::fs::canonicalize(&dir).unwrap();
    let got_c = std::fs::canonicalize(&got).unwrap();
    assert_eq!(got_c, want);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn absolute_path_is_used_regardless_of_cwd() {
    let dir = std::env::temp_dir().join("helm-args-abs");
    std::fs::create_dir_all(&dir).unwrap();

    // 檔案總管右鍵給的是絕對路徑，且行程 cwd 與它無關。
    let got = folder_from_args(&arg(dir.to_str().unwrap()), Path::new("/"))
        .expect("absolute path resolves");
    assert!(got.ends_with("helm-args-abs"), "got {got}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn no_argument_means_no_launch_folder() {
    assert_eq!(folder_from_args(&[], &std::env::temp_dir()), None);
}

#[test]
fn nonexistent_path_is_ignored_rather_than_passed_through() {
    // 壞路徑不該一路流到 PTY spawn，寧可當作沒指定資料夾照常啟動。
    let got = folder_from_args(&arg("helm-definitely-missing-dir"), &std::env::temp_dir());
    assert_eq!(got, None);
}

#[test]
fn windows_paths_survive_without_unc_prefix() {
    let dir = std::env::temp_dir().join("helm-args-unc");
    std::fs::create_dir_all(&dir).unwrap();

    let got = folder_from_args(&arg(dir.to_str().unwrap()), Path::new(".")).unwrap();
    // UNC 前綴會讓 workspace 的字面比對認不出同一個資料夾。
    assert!(!got.starts_with(r"\\?\"), "got {got}");

    std::fs::remove_dir_all(&dir).ok();
}
