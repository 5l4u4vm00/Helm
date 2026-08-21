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

/**
 * Sidebar display form of a folder path: clipped from the **head** so the
 * trailing segments (the folder name — the part that says which project this
 * is) survive. `C:\Users\me\src\deep\nest\helm` → `…\deep\nest\helm`.
 *
 * Why this is not CSS: `text-overflow: ellipsis` only ever trims the tail, and
 * the usual trick for flipping it — `direction: rtl` — changes the base
 * paragraph direction, so the bidi algorithm reorders the path's LTR runs and
 * drops the ellipsis on the wrong side. Windows paths come out visually
 * scrambled and shoved against the left edge, which is exactly the bug this
 * replaces. Clipping in JS keeps the string pure LTR.
 *
 * `max` is a character budget, not a pixel measurement, so this stays a pure
 * function with no layout read. The sidebar is resizable, so callers derive the
 * budget from its current width via `sidebarCharBudget` below rather than
 * relying on the default.
 *
 * Keep the default **conservative**. Overshooting is the one failure that
 * matters here: CSS then clips the tail, which throws away the folder name —
 * precisely what head-clipping exists to protect. Undershooting only leaves a
 * little width unused. The default ~30 chars is what fits the sidebar row at
 * 10px at its default width; the diff header passes a larger budget because it
 * is far wider.
 *
 * Separators are preserved as written — a Windows path keeps its backslashes —
 * because this string is also what the user copies out of the tooltip.
 */
export function displayFolderPath(folder: string, max = 30): string {
  if (max <= 1 || folder.length <= max) return folder;
  // Take the budget's worth of tail, then start at its *first* separator so the
  // result begins on a segment boundary instead of mid-name. First (not last)
  // is what keeps the most segments that still fit.
  //
  // Consequence worth knowing: the output can be well under `max` when a
  // separator sits just inside the window, so the budget is an upper bound
  // rather than a target. Widening it a little buys a whole extra segment.
  const tail = folder.slice(folder.length - (max - 1));
  const sep = tail.search(/[/\\]/);
  // No separator inside the window: one enormous segment, so hard-cut it.
  return sep >= 0 ? `…${tail.slice(sep)}` : `…${tail}`;
}

/**
 * Middle-elided display form, for strings whose **both ends** identify them —
 * a workspace name is often `<project> (<branch>)` or a folder basename with a
 * qualifying suffix, so tail clipping throws away half the answer.
 * `Backend Services — staging` → `Backend S…staging`.
 *
 * Deliberately not `displayFolderPath`: that one protects the tail because a
 * path's head is the least informative part. Here neither end is disposable.
 *
 * Below 5 the result would be mostly ellipsis, so the raw string is returned
 * and CSS `text-overflow` takes over — the same "undershooting is the safe
 * failure" reasoning as above.
 */
export function middleEllipsis(text: string, max: number): string {
  if (max < 5 || text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * Sidebar width (px) → character budget for the two clipped strings in it
 * (`displayFolderPath`, `middleEllipsis`). Keeps them honest as the user drags
 * the sidebar: a fixed budget would waste a wide sidebar and overflow a narrow
 * one.
 *
 * Still a character estimate, not a measurement — `perChar` is the average
 * advance of the 10px sidebar font and `chrome` covers the row's indent, icon
 * and clear button. Rounding **down** keeps the conservative bias
 * `displayFolderPath` documents; the floor stops a minimum-width sidebar from
 * producing a budget so small that everything is ellipsis.
 */
export function sidebarCharBudget(widthPx: number, perChar = 5.2, chrome = 44): number {
  if (!Number.isFinite(widthPx)) return 12;
  return Math.max(12, Math.floor((widthPx - chrome) / perChar));
}

/**
 * Same idea for the workspace **name**, which lives on a busier line: the
 * chevron, the session count and (sometimes) the approval badge share it, and
 * it renders at 11px bold rather than 10px. A budget tuned for the folder line
 * is too generous here — the name then gets CSS-clipped from the tail before
 * `middleEllipsis` ever trims it, which loses the trailing half that
 * middle-eliding exists to keep.
 */
export function workspaceNameBudget(widthPx: number): number {
  return sidebarCharBudget(widthPx, 6.4, 72);
}
