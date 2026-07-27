// Roving focus for vertical lists / menus, driven by the live DOM
// (no index state to keep in sync with dynamic lists).

/** Subset of KeyboardEvent the region-layer guard needs (keeps this DOM-free). */
export interface ModifierStateLike {
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * Region-layer rule: bare keys only. A row/list action must never fire from
 * Ctrl+j, Alt+f or Cmd+x — those belong to the global layer or the OS. Shift
 * stays allowed because some keys encode it in the character itself ('G').
 */
export function hasNonShiftModifier(e: ModifierStateLike): boolean {
  return Boolean(e.ctrlKey || e.altKey || e.metaKey);
}

/** Vim aliases (list items are never text inputs, so always active). */
const VIM_ALIASES: Record<string, string> = {
  j: "ArrowDown",
  k: "ArrowUp",
  g: "Home",
  G: "End",
};

/**
 * Move focus among the container's items for ArrowUp/ArrowDown/Home/End
 * (vim: j/k/g/G). Returns true when the key was handled (caller should
 * preventDefault).
 */
// compareDocumentPosition bitmasks (local so test stubs don't need a Node global).
const POSITION_FOLLOWING = 4;
const POSITION_PRECEDING = 2;

/**
 * Focus the nearest item after (dir=1) / before (dir=-1) `from` in document
 * order, wrapping to the first/last item when none. For callers whose focused
 * element is not itself a list item (e.g. a workspace header between session
 * rows). Returns true when the key was handled.
 */
export function focusNearestItem(
  from: HTMLElement,
  container: HTMLElement | null,
  itemSelector: string,
  dir: 1 | -1,
): boolean {
  if (!container) return false;
  const items = [...container.querySelectorAll<HTMLElement>(itemSelector)];
  if (items.length === 0) return false;
  const mask = dir === 1 ? POSITION_FOLLOWING : POSITION_PRECEDING;
  const candidates = items.filter((el) => from.compareDocumentPosition(el) & mask);
  const next =
    dir === 1
      ? (candidates[0] ?? items[0])
      : (candidates[candidates.length - 1] ?? items[items.length - 1]);
  next.focus();
  return true;
}

export function handleListKey(
  key: string,
  container: HTMLElement | null,
  itemSelector: string,
): boolean {
  if (!container) return false;
  key = VIM_ALIASES[key] ?? key;
  const items = [...container.querySelectorAll<HTMLElement>(itemSelector)];
  if (items.length === 0) return false;
  const idx = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "ArrowDown") {
    next = idx < 0 ? 0 : (idx + 1) % items.length;
  } else if (key === "ArrowUp") {
    next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
  } else if (key === "Home") {
    next = 0;
  } else if (key === "End") {
    next = items.length - 1;
  } else {
    return false;
  }
  items[next].focus();
  return true;
}
