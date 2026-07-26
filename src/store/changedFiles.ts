// Merging changed-file entries from the two detection paths.
// Pure and dependency-free so node can test it.
//
// The same edit can arrive twice with different paths: the hook reports an
// absolute `file_path`, while the viewport regex sees whatever the TUI
// printed (often just a basename). Keyed on raw string equality those become
// two rows for one file, one of which cannot be diffed — merely ugly before
// the diff view existed, actively misleading now.
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。
import type { ChangedFile } from "../agents/extract.ts";

/** Upper bound on the per-session list; a long agent run is otherwise unbounded. */
export const CHANGED_FILES_CAP = 200;

/** Trailing path segment, for both separator styles. */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Merge `incoming`, keeping the better-sourced path. Provenance only ever
 *  improves: a hook entry is never downgraded back to a scan one. */
function merged(existing: ChangedFile, incoming: ChangedFile): ChangedFile {
  const keepExistingPath = existing.source === "hook" && incoming.source !== "hook";
  return {
    op: incoming.op,
    path: keepExistingPath ? existing.path : incoming.path,
    source: existing.source === "hook" ? "hook" : incoming.source,
    cwd: incoming.cwd ?? existing.cwd,
  };
}

/**
 * Add one entry to a session's changed-file list. Returns the original array
 * unchanged (reference-equal) when nothing would differ, so the caller can
 * skip a store write — this runs on every idempotent viewport re-scan.
 */
export function mergeChangedFile(files: ChangedFile[], incoming: ChangedFile): ChangedFile[] {
  const exactIdx = files.findIndex((f) => f.path === incoming.path);
  if (exactIdx >= 0) {
    const next = merged(files[exactIdx], incoming);
    const cur = files[exactIdx];
    if (
      cur.op === next.op &&
      cur.path === next.path &&
      cur.source === next.source &&
      cur.cwd === next.cwd
    ) {
      return files;
    }
    return files.map((f, i) => (i === exactIdx ? next : f));
  }

  // An absolute path can upgrade an earlier relative sighting of the same
  // file. Replaced in place so the list does not reorder while streaming.
  if (isAbsolute(incoming.path)) {
    const base = basename(incoming.path);
    const looseIdx = files.findIndex(
      (f) => f.source !== "hook" && !isAbsolute(f.path) && basename(f.path) === base,
    );
    if (looseIdx >= 0) {
      return files.map((f, i) => (i === looseIdx ? merged(f, incoming) : f));
    }
  }

  const next = [...files, incoming];
  return next.length > CHANGED_FILES_CAP ? next.slice(next.length - CHANGED_FILES_CAP) : next;
}
