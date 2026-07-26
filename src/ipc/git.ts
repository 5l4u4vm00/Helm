// 前端呼叫 Rust 唯讀 git diff 的封裝層。
import { invoke } from "@tauri-apps/api/core";

/** Rust reports expected outcomes as statuses so they can be localized;
 *  "error" is added here for the rejection case only. */
export type GitDiffStatus =
  | "ok"
  | "unchanged"
  | "untracked"
  | "missing"
  | "not_a_repo"
  | "no_git"
  | "error";

export interface GitDiffResult {
  status: GitDiffStatus;
  path: string;
  repoRoot?: string;
  patch: string;
  truncated: boolean;
}

/** Read-only diff of one file against HEAD. Returns a status instead of
 *  throwing: a pure-browser environment (`npm run dev`) rejects every invoke,
 *  and the viewer should render a state rather than an unhandled rejection. */
export async function gitDiffFile(args: {
  baseDir?: string;
  path: string;
}): Promise<GitDiffResult> {
  try {
    return await invoke<GitDiffResult>("git_diff_file", args);
  } catch {
    return { status: "error", path: args.path, patch: "", truncated: false };
  }
}
