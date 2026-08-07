// Pure helpers for "open Helm in this folder" (CLI `helm .`, Explorer context
// menu). No React/Zustand deps, unit-tested.
//
// A launch folder has to be matched against workspace folders that the user
// picked earlier through a native dialog, so the two spellings of the same
// directory rarely match byte for byte: the shell hands us `C:\repo\`, the
// picker stored `C:/repo`, and Windows treats both as the same place
// case-insensitively. Comparing raw strings would create a duplicate
// workspace on every launch.

import type { Workspace } from "./workspaceGroups";

/**
 * Canonical form for comparing two directory paths: forward slashes, no
 * trailing separator, lower-cased on Windows only (Unix paths are
 * case-sensitive and `/Repo` really is not `/repo`).
 *
 * Purely lexical — no filesystem access, so symlinks and `..` segments are
 * not resolved. The launch path comes from the OS as an absolute path and the
 * workspace folder from the native picker, so both are already normalized in
 * practice.
 */
export function normalizeFolderPath(path: string, isWindows: boolean): string {
  const slashed = path.replace(/\\/g, "/").trim();
  // Keep the root itself ("/" or "C:/") — stripping its slash would leave
  // "" or "C:", neither of which is the same directory.
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  const root = /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
  return isWindows ? root.toLowerCase() : root;
}

/** Whether two paths denote the same directory (see normalizeFolderPath). */
export function isSameFolder(a: string, b: string, isWindows: boolean): boolean {
  return normalizeFolderPath(a, isWindows) === normalizeFolderPath(b, isWindows);
}

/**
 * The existing workspace already bound to `folder`, or undefined.
 * First match wins: duplicates can only come from hand-edited storage, and
 * reusing the earliest keeps the choice stable across launches.
 */
export function findWorkspaceByFolder(
  workspaces: Workspace[],
  folder: string,
  isWindows: boolean,
): Workspace | undefined {
  return workspaces.find((w) => w.folder && isSameFolder(w.folder, folder, isWindows));
}

/**
 * Workspace name for a launch folder: the directory's own basename, so
 * `C:\src\helm` shows up as "helm" rather than "Workspace 3".
 * Falls back to the whole path when there is no basename to take (a drive
 * root such as `C:\`, or `/`).
 */
export function workspaceNameForFolder(folder: string): string {
  const parts = folder
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  const last = parts[parts.length - 1];
  return last ?? folder;
}
