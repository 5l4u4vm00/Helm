// Deciding which directory to run git in for a changed-file entry.
// Pure (no filesystem, no node:path — this runs in the webview); Rust does
// the canonicalizing.
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。
import type { ChangedFile } from "../agents/extract.ts";

export type DiffBlockReason = "truncated" | "unresolvable";

export interface DiffBase {
  /** Directory to resolve a relative path against; undefined when the path is
   *  already absolute (Rust then anchors git at the file's own directory). */
  baseDir?: string;
  path: string;
  /** Set when we can tell up front that no diff is possible — skip the IPC. */
  reason?: DiffBlockReason;
}

export function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) || // C:\x or C:/x
    path.startsWith("\\\\") // \\server\share
  );
}

/** Paths the viewport regex captured can be ellipsized by the terminal width
 *  ("src/…/foo.ts", "src/.../foo.ts"). No point asking git about those. */
function looksTruncated(path: string): boolean {
  return path.includes("…") || path.includes("...");
}

/**
 * Resolve where to run git, in decreasing order of trustworthiness:
 *   1. the entry's own absolute path (hook-sourced; immune to the user cd-ing)
 *   2. the agent CLI's cwd when the tool ran (hook payload)
 *   3. the session's creation-time cwd snapshot
 *   4. the global default working directory
 * `session.cwd` deliberately does not lead: it is a snapshot, is undefined
 * when the workspace has no folder, and goes stale as soon as the user cds.
 */
export function resolveDiffBase(
  entry: Pick<ChangedFile, "path" | "source" | "cwd">,
  session: { cwd?: string } | undefined,
  defaultCwd: string,
): DiffBase {
  const path = entry.path.trim();
  if (!path || path.includes("\n")) return { path, reason: "unresolvable" };
  if (looksTruncated(path)) return { path, reason: "truncated" };

  if (isAbsolutePath(path)) return { path };

  const baseDir = entry.cwd || session?.cwd || defaultCwd || undefined;
  if (!baseDir) return { path, reason: "unresolvable" };
  return { baseDir, path };
}
