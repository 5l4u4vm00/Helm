// Filesystem probes for paths the frontend persists across launches.
// A workspace folder is stored in localStorage, so by the next launch it can
// point at an unmounted volume, a deleted worktree, or a renamed project —
// the sidebar flags those instead of silently starting sessions in $HOME.

/// Whether `path` currently resolves to a readable directory.
#[tauri::command]
pub fn dir_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).is_dir())
}
