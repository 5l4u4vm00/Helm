// Single source for the shortcut reference: the in-app help dialog and the
// README section are both generated from here, so neither can drift from the
// tables that actually resolve keys (PREFIX_TABLE, KEYMAP, SIDEBAR_TABLE).
// Pure module (no stores / DOM), so scripts and node tests can call it.
//
// Rows carry i18n keys rather than resolved text. For prefix/direct rows the
// key is the same `command.*` entry the registry uses for its palette title,
// so wording lives in exactly one place.
import { SIDEBAR_TABLE } from "../components/SessionSidebar/sidebarKeymap.ts";
import { KEYMAP, shortcutLabel } from "./keymap.ts";
import { DIGITS_LABEL, whichKeyHints } from "./prefix.ts";

export interface ShortcutRow {
  /** Already platform-formatted, e.g. "Ctrl+A %" or "j · k · ↑ · ↓". */
  keys: string;
  titleKey: string;
}

export interface ShortcutSection {
  titleKey: string;
  /** Optional explanatory line under the section heading. */
  noteKey?: string;
  rows: ShortcutRow[];
}

/**
 * commandId → the i18n key the registry uses for that command's title.
 * Every command reachable by a key must appear here; tests enforce that.
 */
const COMMAND_TITLE_KEYS: Record<string, string> = {
  "palette:open": "command.paletteOpen",
  "layout:split-right": "command.splitRight",
  "layout:split-down": "command.splitDown",
  "layout:close-pane": "command.closePane",
  "layout:focus-next-pane": "command.focusNextPane",
  // The registry composes these four from a direction parameter; the reference
  // collapses them into one row instead (see ARROW_GROUPS).
  "layout:focus-left": "shortcut.prefix.focusPane",
  "layout:focus-right": "shortcut.prefix.focusPane",
  "layout:focus-up": "shortcut.prefix.focusPane",
  "layout:focus-down": "shortcut.prefix.focusPane",
  "layout:resize-left": "command.resizeLeft",
  "layout:resize-right": "command.resizeRight",
  "layout:resize-up": "command.resizeUp",
  "layout:resize-down": "command.resizeDown",
  "session:new": "command.newSession",
  "session:next": "command.nextSession",
  "session:prev": "command.prevSession",
  "session:rename-active": "command.renameSession",
  // switch-1..9 collapse into a single "1…9" row (as in the which-key overlay).
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`session:switch-${i + 1}`, "whichKey.switchDigits"]),
  ),
  "workspace:new": "command.newWorkspace",
  "view:toggle-files": "command.toggleFiles",
  "view:toggle-notifications": "command.toggleNotifications",
  "view:toggle-approval": "command.toggleApproval",
  "view:toggle-sidebar": "command.toggleSidebar",
  "theme:toggle": "command.toggleTheme",
  "settings:open": "command.openSettings",
  "approval:approve-active": "command.approveActive",
  "approval:reject-active": "command.rejectActive",
  "approval:approve-all": "command.approveAll",
  "approval:reject-all": "command.rejectAll",
  "focus:cycle-region": "command.cycleFocusRegion",
  "focus:cycle-region-back": "command.cycleFocusRegionBack",
  "focus:terminal": "command.focusTerminal",
  "focus:sidebar": "command.focusSidebar",
  "terminal:send-prefix": "command.sendCtrlA",
  "help:shortcuts": "command.shortcutsHelp",
};

/** Lookup used by the generator/tests so a missing mapping is visible. */
export function titleKeyFor(commandId: string): string | undefined {
  return COMMAND_TITLE_KEYS[commandId];
}

// e.key values → what a user sees on the keycap.
const KEY_LABELS: Record<string, string> = {
  Escape: "Esc",
  " ": "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

function keyList(keys: string[]): string {
  return keys.map((k) => KEY_LABELS[k] ?? k).join(" · ");
}

// Four directional bindings read better as one row: the first one carries the
// group label, the rest are folded into it.
const ARROW_GROUP_LEAD = "layout:focus-left";
const ARROW_GROUP_REST = new Set([
  "layout:focus-right",
  "layout:focus-up",
  "layout:focus-down",
]);

/** Prefix sequences, in PREFIX_TABLE order (digits collapsed, dupes removed). */
function prefixSection(isMac: boolean): ShortcutSection {
  const rows: ShortcutRow[] = [];
  for (const hint of whichKeyHints(isMac)) {
    if (ARROW_GROUP_REST.has(hint.commandId)) continue;
    const titleKey = COMMAND_TITLE_KEYS[hint.commandId];
    if (!titleKey) continue;
    let keys = hint.keyLabel;
    if (hint.commandId === ARROW_GROUP_LEAD) keys = "← · → · ↑ · ↓";
    else if (hint.keyLabel === DIGITS_LABEL) keys = DIGITS_LABEL;
    rows.push({ keys, titleKey });
  }
  return { titleKey: "shortcut.section.prefix", noteKey: "shortcut.prefixNote", rows };
}

/** The few shortcuts that work without the prefix. */
function directSection(isMac: boolean): ShortcutSection {
  const rows: ShortcutRow[] = [];
  for (const b of KEYMAP) {
    const titleKey = COMMAND_TITLE_KEYS[b.commandId];
    const keys = shortcutLabel(b.commandId, isMac);
    if (!titleKey || !keys) continue;
    rows.push({ keys, titleKey });
  }
  return { titleKey: "shortcut.section.direct", rows };
}

/** Bare keys acting on the focused sidebar row (see SIDEBAR_TABLE). */
function sidebarSection(): ShortcutSection {
  const rows: ShortcutRow[] = [
    { keys: "j · k · ↑ · ↓ · g · G", titleKey: "shortcut.sidebar.navigate" },
    ...SIDEBAR_TABLE.map((b) => ({ keys: keyList(b.keys), titleKey: b.titleKey })),
  ];
  return { titleKey: "shortcut.section.sidebar", noteKey: "shortcut.sidebarNote", rows };
}

// The remaining two sections describe per-component handlers that have no
// table to read from; they are hand-maintained, but at least in one place.
const PANEL_ROWS: ShortcutRow[] = [
  { keys: "Esc", titleKey: "shortcut.panels.dismiss" },
  { keys: "Tab · Shift+Tab", titleKey: "shortcut.panels.trap" },
  { keys: "Enter · Space", titleKey: "shortcut.panels.activate" },
  { keys: "j · k · ↑ · ↓ · g · G", titleKey: "shortcut.panels.navigate" },
  { keys: "[ · ]", titleKey: "shortcut.panels.diffStep" },
  { keys: "Tab · ← → ↑ ↓ · Enter", titleKey: "shortcut.panels.resizer" },
  { keys: "ContextMenu · Shift+F10", titleKey: "shortcut.panels.launcherMenu" },
  { keys: "Enter · Esc", titleKey: "shortcut.panels.confirm" },
];

const TERMINAL_ROWS: ShortcutRow[] = [
  { keys: "Ctrl+/", titleKey: "shortcut.terminal.ctrlSlash" },
  { keys: "Ctrl+C", titleKey: "shortcut.terminal.copySelection" },
  { keys: "Ctrl+A", titleKey: "shortcut.terminal.selectAll" },
];

export function buildShortcutDocs(isMac: boolean): ShortcutSection[] {
  return [
    prefixSection(isMac),
    directSection(isMac),
    sidebarSection(),
    { titleKey: "shortcut.section.panels", rows: PANEL_ROWS },
    { titleKey: "shortcut.section.terminal", rows: TERMINAL_ROWS },
  ];
}
