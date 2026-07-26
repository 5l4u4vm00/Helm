// tmux-style prefix key (Ctrl+A): table + state machine (pure, node-testable).
// Pressing Ctrl+A "arms" prefix mode; the next keystroke picks a command from
// PREFIX_TABLE. Matching semantics:
// - single-char `key` entries compare e.key case-sensitively and ignore
//   shiftKey — the character itself carries shift ('"', '%', 'N');
// - named-key entries (Tab, arrows) and `code` entries (Digit1..9) compare
//   ctrl/shift strictly;
// - an unknown second key is swallowed and cancels the prefix (tmux behavior).
import type { KeyEventLike } from "./types";

/** Armed mode auto-expires after this long (which-key overlay lifetime). */
export const PREFIX_TIMEOUT_MS = 3000;

export interface PrefixBinding {
  /** Exact, case-sensitive e.key match ('"', '%', 'N', 'Tab', 'ArrowLeft'…). */
  key?: string;
  /** Matched against e.code (layout-independent digits); wins over `key`. */
  code?: string;
  /** Second key must be pressed with Ctrl (resize arrows, literal Ctrl+A). */
  ctrl?: boolean;
  /** Only meaningful for named-key / code entries; single chars encode shift. */
  shift?: boolean;
  commandId: string;
}

export const PREFIX_TABLE: PrefixBinding[] = [
  { key: "%", commandId: "layout:split-right" },
  { key: '"', commandId: "layout:split-down" },
  { key: "x", commandId: "layout:close-pane" },
  { key: "o", commandId: "layout:focus-next-pane" },
  { key: "ArrowLeft", commandId: "layout:focus-left" },
  { key: "ArrowRight", commandId: "layout:focus-right" },
  { key: "ArrowUp", commandId: "layout:focus-up" },
  { key: "ArrowDown", commandId: "layout:focus-down" },
  { key: "ArrowLeft", ctrl: true, commandId: "layout:resize-left" },
  { key: "ArrowRight", ctrl: true, commandId: "layout:resize-right" },
  { key: "ArrowUp", ctrl: true, commandId: "layout:resize-up" },
  { key: "ArrowDown", ctrl: true, commandId: "layout:resize-down" },
  { key: "c", commandId: "session:new" },
  { key: "n", commandId: "session:next" },
  { key: "p", commandId: "session:prev" },
  { key: "r", commandId: "session:rename-active" },
  ...Array.from({ length: 9 }, (_, i) => ({
    code: `Digit${i + 1}`,
    commandId: `session:switch-${i + 1}`,
  })),
  { key: "g", commandId: "focus:sidebar" },
  { key: "w", commandId: "workspace:new" },
  { key: "f", commandId: "view:toggle-files" },
  { key: "e", commandId: "view:toggle-sidebar" },
  { key: "t", commandId: "theme:toggle" },
  { key: "s", commandId: "settings:open" },
  { key: "y", commandId: "approval:approve-active" },
  { key: "N", commandId: "approval:reject-active" },
  { key: "Tab", commandId: "focus:cycle-region" },
  { key: "Tab", shift: true, commandId: "focus:cycle-region-back" },
  // screen-style literal passthrough: C-a a / C-a C-a → 0x01 to the PTY.
  { key: "a", commandId: "terminal:send-prefix" },
  { key: "a", ctrl: true, commandId: "terminal:send-prefix" },
];

/** Strict Ctrl+A: any extra modifier (or Cmd) is not the prefix. */
export function isPrefixKey(e: KeyEventLike): boolean {
  return (
    e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a"
  );
}

export type PrefixAction =
  | { type: "arm" }
  | { type: "run"; commandId: string }
  | { type: "cancel" }
  | { type: "ignore" }
  | { type: "pass" };

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

function bindingMatches(b: PrefixBinding, e: KeyEventLike): boolean {
  if ((b.ctrl ?? false) !== e.ctrlKey) return false;
  if (b.code) {
    if (b.code !== e.code) return false;
    return (b.shift ?? false) === e.shiftKey;
  }
  const key = b.key ?? "";
  if (key.length > 1) {
    if (key !== e.key) return false;
    return (b.shift ?? false) === e.shiftKey;
  }
  // Single character: shift is encoded in the character itself.
  return key === e.key;
}

/**
 * Decide what a keydown means for the prefix state machine.
 * Callers swallow the event for every action except "pass".
 */
export function resolvePrefixInput(armed: boolean, e: KeyEventLike): PrefixAction {
  if (!armed) return isPrefixKey(e) ? { type: "arm" } : { type: "pass" };
  // A lone modifier keydown (user is composing Ctrl+arrow etc.) keeps waiting.
  if (MODIFIER_KEYS.has(e.key)) return { type: "ignore" };
  if (e.key === "Escape") return { type: "cancel" };
  if (e.metaKey || e.altKey) return { type: "cancel" };
  for (const b of PREFIX_TABLE) {
    if (bindingMatches(b, e)) return { type: "run", commandId: b.commandId };
  }
  return { type: "cancel" };
}

const NAMED_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Tab: "Tab",
};

function secondKeyLabel(b: PrefixBinding, isMac: boolean): string {
  const base = b.code?.startsWith("Digit")
    ? b.code.slice(5)
    : (NAMED_LABELS[b.key ?? ""] ?? b.key ?? "");
  const ctrl = b.ctrl ? (isMac ? "⌃" : "Ctrl+") : "";
  const shift = b.shift ? (isMac ? "⇧" : "Shift+") : "";
  return `${ctrl}${shift}${base}`;
}

/** Human-readable sequence for a command ("⌃A %" / "Ctrl+A %"). */
export function prefixLabel(commandId: string, isMac: boolean): string | undefined {
  const b = PREFIX_TABLE.find((x) => x.commandId === commandId);
  if (!b) return undefined;
  return `${isMac ? "⌃A" : "Ctrl+A"} ${secondKeyLabel(b, isMac)}`;
}

export interface WhichKeyHint {
  keyLabel: string;
  commandId: string;
}

/** Collapsed Digit1..9 row label in which-key hints. */
export const DIGITS_LABEL = "1…9";

/**
 * Rows for the which-key overlay, in table order: Digit1..9 collapse into a
 * single "1…9" row, and a command bound twice (send-prefix) appears once.
 */
export function whichKeyHints(isMac: boolean): WhichKeyHint[] {
  const rows: WhichKeyHint[] = [];
  const seen = new Set<string>();
  let digitsDone = false;
  for (const b of PREFIX_TABLE) {
    if (b.code?.startsWith("Digit")) {
      if (!digitsDone) {
        rows.push({ keyLabel: DIGITS_LABEL, commandId: b.commandId });
        digitsDone = true;
      }
      continue;
    }
    if (seen.has(b.commandId)) continue;
    seen.add(b.commandId);
    rows.push({ keyLabel: secondKeyLabel(b, isMac), commandId: b.commandId });
  }
  return rows;
}
