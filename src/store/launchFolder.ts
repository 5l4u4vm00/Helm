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
 * Same idea for the workspace **name**, which lives on a much busier line: the
 * chevron (9px), the session count (14px), sometimes the approval badge, and the
 * four action buttons (20px each) all share it, so the reserve is far larger
 * than the folder line's. A budget tuned for that line is too generous here —
 * the name then gets CSS-clipped from the tail before `middleEllipsis` ever
 * trims it, which loses the trailing half that middle-eliding exists to keep.
 *
 * `perChar` is well *above* the folder line's even though the name renders at a
 * smaller 10px: it is bold, uppercase and letter-spaced, and caps carry no
 * narrow lowercase forms to average the advance down.
 *
 * Both numbers were **measured**, not estimated: the name box is exactly
 * `sidebarWidth - 124 - 20 * badges` px and its font averages 6.83px per
 * uppercase character including tracking. `chrome` is rounded up and `perChar`
 * up to 7.1 so the budget lands just *under* what the box holds — the
 * conservative bias `middleEllipsis` documents. Overshooting is the failure that
 * matters: CSS then clips the tail before `middleEllipsis` ever runs, destroying
 * the trailing half that middle-eliding exists to keep.
 *
 * `alwaysOnBadges` is the count of 20px controls that stay visible on the line
 * when the pointer is elsewhere — the folder and recipe buttons keep their tint
 * at rest (that state is information, not an action) and the approval badge
 * pulses until answered. They cannot fold into `chrome`: a workspace with a
 * folder set is permanently 20px narrower than one without, and charging every
 * row for badges it does not have would over-elide the common case.
 *
 * Deliberately **not** routed through `sidebarCharBudget`: its 12-character
 * floor is wider than this box at the minimum sidebar width (180px with one
 * badge leaves 36px ≈ 5 characters), so the floor itself would overshoot and
 * hand the tail back to CSS.
 *
 * The floor is **5**, not lower, because that is `middleEllipsis`'s own cutoff:
 * below it that function returns the string *untouched*, so a floor of 4 does not
 * mean "elide hard" — it means no eliding happens at all and the full name spills
 * out for CSS to clip from the tail. Exactly the failure this budget exists to
 * prevent, and invisible until you measure the box.
 */
export function workspaceNameBudget(widthPx: number, alwaysOnBadges = 0): number {
  if (!Number.isFinite(widthPx)) return 12;
  const badges = Math.max(0, alwaysOnBadges);
  return Math.max(5, Math.floor((widthPx - 128 - badges * 20) / 7.1));
}
