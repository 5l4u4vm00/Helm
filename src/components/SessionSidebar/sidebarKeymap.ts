// Sidebar-local keyboard mapping. Keeping this DOM-free makes the interaction
// contract easy to test and prevents workspace/session rows from drifting.
// A table (rather than an if-chain) so the shortcut reference can be generated
// from it — see commands/shortcutDocs.ts.
import { hasNonShiftModifier, type ModifierStateLike } from "../../focus/listNav.ts";

export type SidebarTarget = "workspace" | "session";

export type SidebarShortcut =
  | "activate-session"
  | "toggle-workspace"
  | "focus-parent"
  | "collapse-workspace"
  | "expand-or-enter-workspace"
  | "rename"
  | "new-session"
  | "new-workspace"
  | "choose-folder"
  | "request-delete"
  | "focus-terminal";

export interface SidebarBinding {
  /** e.key values that trigger the action; keys[0] is the canonical label. */
  keys: string[];
  action: SidebarShortcut;
  /** Rows this applies to; absent = both. */
  targets?: SidebarTarget[];
  /** i18n key for the generated shortcut reference. */
  titleKey: string;
}

/**
 * Letters are aligned with the global layer on purpose: `c`/`w`/`x`/`r` mean the
 * same thing here as after the Ctrl+A prefix. `f` (folder) and `g`/`G` (list
 * navigation, handled by listNav) are region-local vocabulary and deliberately
 * differ from the global `Ctrl+A f`/`Ctrl+A g`.
 */
export const SIDEBAR_TABLE: SidebarBinding[] = [
  { keys: ["r", "F2"], action: "rename", titleKey: "shortcut.sidebar.rename" },
  { keys: ["c"], action: "new-session", titleKey: "shortcut.sidebar.newSession" },
  { keys: ["w"], action: "new-workspace", titleKey: "shortcut.sidebar.newWorkspace" },
  { keys: ["f"], action: "choose-folder", titleKey: "shortcut.sidebar.chooseFolder" },
  {
    keys: ["Delete", "Backspace", "x"],
    action: "request-delete",
    titleKey: "shortcut.sidebar.delete",
  },
  { keys: ["Escape"], action: "focus-terminal", titleKey: "shortcut.sidebar.focusTerminal" },
  {
    keys: ["Enter", " "],
    action: "activate-session",
    targets: ["session"],
    titleKey: "shortcut.sidebar.activateSession",
  },
  {
    keys: ["Enter", " "],
    action: "toggle-workspace",
    targets: ["workspace"],
    titleKey: "shortcut.sidebar.toggleWorkspace",
  },
  {
    keys: ["h", "ArrowLeft"],
    action: "focus-parent",
    targets: ["session"],
    titleKey: "shortcut.sidebar.focusParent",
  },
  {
    keys: ["h", "ArrowLeft"],
    action: "collapse-workspace",
    targets: ["workspace"],
    titleKey: "shortcut.sidebar.collapse",
  },
  {
    keys: ["l", "ArrowRight"],
    action: "expand-or-enter-workspace",
    targets: ["workspace"],
    titleKey: "shortcut.sidebar.expand",
  },
];

/** Subset of KeyboardEvent this module needs (keeps it DOM-free). */
export interface SidebarKeyLike extends ModifierStateLike {
  key: string;
}

export function resolveSidebarShortcut(
  target: SidebarTarget,
  e: SidebarKeyLike,
): SidebarShortcut | null {
  if (hasNonShiftModifier(e)) return null;
  for (const b of SIDEBAR_TABLE) {
    if (b.targets && !b.targets.includes(target)) continue;
    if (b.keys.includes(e.key)) return b.action;
  }
  return null;
}
