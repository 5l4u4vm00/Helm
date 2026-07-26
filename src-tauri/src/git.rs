// Read-only git diff for one file, for the Changed Files panel.
//
// Read-only by construction: only `rev-parse`, `diff`, and `status` are ever
// run. Untracked files get a synthesized patch rather than `git add -N`,
// which would write to the index.
//
// The anchor is the file's own directory, not the session's cwd: `session.cwd`
// is a creation-time snapshot that goes stale the moment the user cds, and is
// absent entirely when the workspace has no folder. (Reading the PTY child's
// real cwd would be more precise still, but needs three platform-specific
// implementations — macOS libproc, /proc on Linux, NtQueryInformationProcess
// on Windows — for a case the file's own absolute path already covers.)
//
// Shelling out to `git` rather than linking git2/gix keeps the release binary
// small, which [profile.release] in Cargo.toml explicitly optimizes for.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Largest patch we will move across IPC. Enforced while reading the child's
/// stdout so a huge minified file never lands in memory at all.
const PATCH_CAP: usize = 512 * 1024;
/// A NUL byte within this many bytes means "binary" for a synthesized patch.
const BINARY_SNIFF: usize = 8000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    /// "ok" | "unchanged" | "untracked" | "missing" | "not_a_repo" | "no_git".
    /// Expected outcomes are statuses, not Err, so the UI can localize them.
    status: String,
    /// Repo-relative path when known, else the input path (for display).
    path: String,
    repo_root: Option<String>,
    /// Unified diff; empty for every status except ok/untracked.
    patch: String,
    truncated: bool,
}

impl GitDiff {
    fn status(status: &str, path: String) -> Self {
        Self {
            status: status.into(),
            path,
            repo_root: None,
            patch: String::new(),
            truncated: false,
        }
    }
}

/// Expand a leading `~` against the given home directory.
fn expand_tilde(path: &str, home: Option<&str>) -> PathBuf {
    if path == "~" {
        return home.map_or_else(|| PathBuf::from(path), PathBuf::from);
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home {
            return Path::new(h).join(rest);
        }
    }
    // `~name` (another user's home) is left alone: resolving it needs passwd
    // lookups and it never appears in agent output.
    PathBuf::from(path)
}

/// Path relative to the repo root, with separators normalized to `/`.
/// None when the file lies outside the repository.
fn to_repo_relative(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Cut a patch at the last newline before `cap`, reporting whether it was cut.
fn truncate_at_line(text: &str, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text.to_string(), false);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let head = &text[..end];
    // Fall back to the hard cut when a single line is longer than the cap —
    // do not scan forever looking for a newline that is not there.
    let cut = head.rfind('\n').map_or(end, |i| i + 1);
    (text[..cut].to_string(), true)
}

/// Build a unified diff for a file git does not track yet, so the frontend
/// has exactly one parser path. `git add -N` would work but writes to the index.
fn synth_untracked_patch(rel: &str, bytes: &[u8]) -> String {
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF)];
    if sniff.contains(&0) {
        return format!("Binary files /dev/null and b/{rel} differ\n");
    }
    let text = String::from_utf8_lossy(bytes);
    if text.is_empty() {
        return format!("--- /dev/null\n+++ b/{rel}\n");
    }
    // A trailing newline terminates the last line rather than starting a new one.
    let body = text.strip_suffix('\n').unwrap_or(&text);
    let lines: Vec<&str> = body.split('\n').collect();
    let mut out = format!(
        "--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for line in &lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if !text.ends_with('\n') {
        out.push_str("\\ No newline at end of file\n");
    }
    out
}

/// Classify `git status --porcelain` output for a single path.
fn classify_porcelain(out: &str) -> &'static str {
    let line = out.lines().next().unwrap_or("").trim_start();
    if line.starts_with("??") {
        "untracked"
    } else if line.is_empty() {
        "clean"
    } else {
        "changed"
    }
}

/// A `git` invocation with the ambient environment neutralized.
/// Every path is a separate argv element after `--`; nothing is ever
/// interpolated into a shell string (same discipline as notify.rs's osascript).
fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("core.quotepath=false") // keep non-ASCII paths readable
        .arg("--no-optional-locks")
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        // A stray variable inherited from Helm's own launch environment could
        // otherwise point git at an entirely different repository.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    cmd
}

/// Run `git diff`, reading at most `PATCH_CAP` bytes of stdout.
/// stderr goes to null on purpose: a capped read of stdout while stderr fills
/// its own pipe is the classic deadlock.
fn run_diff_capped(dir: &Path, args: &[&str], rel: &str) -> std::io::Result<(String, bool, bool)> {
    let mut child = git(dir)
        .args(args)
        .arg("--")
        .arg(rel)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let mut buf = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        // cap + 1 so we can tell "exactly at the cap" from "there was more".
        stdout.take((PATCH_CAP + 1) as u64).read_to_end(&mut buf)?;
    }
    // Stop git early when it has more to say than we will show.
    let over = buf.len() > PATCH_CAP;
    if over {
        let _ = child.kill();
    }
    let ok = child.wait()?.success();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (patch, truncated) = truncate_at_line(&text, PATCH_CAP);
    // A killed child reports failure; that is a truncation, not an error.
    Ok((patch, truncated || over, ok || over))
}

/// Absolute path for the entry, expanding `~` and joining a relative path
/// onto `base_dir`.
fn resolve_abs(base_dir: Option<&str>, path: &str) -> Option<PathBuf> {
    let home = crate::pty::dirs_home();
    let expanded = expand_tilde(path, home.as_deref());
    let abs = if expanded.is_absolute() {
        expanded
    } else {
        Path::new(&expand_tilde(base_dir?, home.as_deref())).join(expanded)
    };
    // Canonicalize when it exists, so a symlinked worktree anchors the real
    // repository; a deleted file keeps its literal path.
    Some(abs.canonicalize().unwrap_or(abs))
}

/// First existing ancestor of `path` — the directory to anchor git at when the
/// file itself (or its whole directory) has been deleted.
fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut cur = path.parent()?;
    loop {
        if cur.is_dir() {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

/// Diff one file against HEAD. Async so a cold FS, a network mount, or a huge
/// repository cannot block the UI thread (same reasoning as fonts.rs).
#[tauri::command]
pub async fn git_diff_file(base_dir: Option<String>, path: String) -> Result<GitDiff, String> {
    let Some(abs) = resolve_abs(base_dir.as_deref(), &path) else {
        return Ok(GitDiff::status("missing", path));
    };
    let Some(anchor) = existing_ancestor(&abs) else {
        return Ok(GitDiff::status("missing", path));
    };

    let root_out = match git(&anchor).args(["rev-parse", "--show-toplevel"]).output() {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GitDiff::status("no_git", path));
        }
        Err(e) => return Err(format!("git failed: {e}")),
    };
    if !root_out.status.success() {
        return Ok(GitDiff::status("not_a_repo", path));
    }
    let root = PathBuf::from(String::from_utf8_lossy(&root_out.stdout).trim());
    let Some(rel) = to_repo_relative(&root, &abs) else {
        return Ok(GitDiff::status("not_a_repo", path));
    };
    let root_str = root.to_string_lossy().into_owned();

    let diff_args = [
        "diff",
        "--no-color",
        // Without these, a repo-local diff.external or a .gitattributes
        // textconv filter would execute arbitrary programs from the target
        // repository just because we wanted to look at a diff.
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--unified=3",
        "HEAD",
    ];
    let (mut patch, mut truncated, ok) =
        run_diff_capped(&root, &diff_args, &rel).map_err(|e| format!("git diff failed: {e}"))?;
    if !ok && patch.is_empty() {
        // Repository with no commits yet: HEAD does not resolve, so compare
        // against the index instead. Retrying costs nothing in the common
        // case, unlike a `rev-parse --verify HEAD` on every single open.
        let cached = [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--unified=3",
            "--cached",
        ];
        let r =
            run_diff_capped(&root, &cached, &rel).map_err(|e| format!("git diff failed: {e}"))?;
        patch = r.0;
        truncated = r.1;
    }

    if !patch.is_empty() {
        return Ok(GitDiff {
            status: "ok".into(),
            path: rel,
            repo_root: Some(root_str),
            patch,
            truncated,
        });
    }

    // Empty patch: either untracked, unchanged, or gone.
    let status_out = git(&root)
        .args(["status", "--porcelain=v1", "--untracked-files=all", "--"])
        .arg(&rel)
        .output()
        .map_err(|e| format!("git status failed: {e}"))?;
    let porcelain = String::from_utf8_lossy(&status_out.stdout);

    if classify_porcelain(&porcelain) == "untracked" {
        let bytes = std::fs::read(&abs).unwrap_or_default();
        let (capped, cut) = truncate_at_line(&synth_untracked_patch(&rel, &bytes), PATCH_CAP);
        return Ok(GitDiff {
            status: "untracked".into(),
            path: rel,
            repo_root: Some(root_str),
            patch: capped,
            truncated: cut,
        });
    }

    let status = if abs.exists() { "unchanged" } else { "missing" };
    Ok(GitDiff {
        status: status.into(),
        path: rel,
        repo_root: Some(root_str),
        patch: String::new(),
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_returns_short_input_untouched() {
        let (out, cut) = truncate_at_line("a\nb\n", 100);
        assert_eq!(out, "a\nb\n");
        assert!(!cut);
    }

    #[test]
    fn truncate_cuts_at_a_line_boundary() {
        let (out, cut) = truncate_at_line("aaa\nbbb\nccc\n", 5);
        assert_eq!(out, "aaa\n");
        assert!(cut);
    }

    #[test]
    fn truncate_handles_a_single_overlong_line() {
        let (out, cut) = truncate_at_line("aaaaaaaaaa", 4);
        assert_eq!(out, "aaaa");
        assert!(cut);
    }

    #[test]
    fn truncate_does_not_split_a_utf8_char() {
        // 測試 is 2 chars x 3 bytes; cap 4 lands mid-character.
        let (out, cut) = truncate_at_line("測試", 4);
        assert_eq!(out, "測");
        assert!(cut);
    }

    #[test]
    fn expand_tilde_forms() {
        assert_eq!(expand_tilde("~", Some("/home/u")), PathBuf::from("/home/u"));
        assert_eq!(
            expand_tilde("~/a/b", Some("/home/u")),
            PathBuf::from("/home/u/a/b")
        );
        assert_eq!(
            expand_tilde("~other/a", Some("/home/u")),
            PathBuf::from("~other/a")
        );
        assert_eq!(expand_tilde("~/a", None), PathBuf::from("~/a"));
        assert_eq!(
            expand_tilde("/abs/a", Some("/home/u")),
            PathBuf::from("/abs/a")
        );
    }

    #[test]
    fn repo_relative_normalizes_and_rejects_outsiders() {
        let root = Path::new("/repo");
        assert_eq!(
            to_repo_relative(root, Path::new("/repo/src/a.ts")).as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(to_repo_relative(root, Path::new("/elsewhere/a.ts")), None);
    }

    #[test]
    fn synth_untracked_counts_lines() {
        let patch = synth_untracked_patch("a.txt", b"one\ntwo\n");
        assert!(patch.starts_with("--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n"));
        assert!(patch.ends_with("+one\n+two\n"));
    }

    #[test]
    fn synth_untracked_marks_a_missing_final_newline() {
        let patch = synth_untracked_patch("a.txt", b"one");
        assert!(patch.contains("@@ -0,0 +1,1 @@"));
        assert!(patch.ends_with("\\ No newline at end of file\n"));
    }

    #[test]
    fn synth_untracked_handles_empty_and_binary() {
        assert_eq!(
            synth_untracked_patch("a.txt", b""),
            "--- /dev/null\n+++ b/a.txt\n"
        );
        let patch = synth_untracked_patch("a.png", b"\x89PNG\x00\x01");
        assert_eq!(patch, "Binary files /dev/null and b/a.png differ\n");
    }

    #[test]
    fn porcelain_classification() {
        assert_eq!(classify_porcelain("?? a.txt\n"), "untracked");
        assert_eq!(classify_porcelain(" M a.txt\n"), "changed");
        assert_eq!(classify_porcelain(""), "clean");
    }
}
