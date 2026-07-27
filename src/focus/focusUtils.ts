// Focus helpers shared by commands, the palette, and components.
// Regions are marked with data-focus-region so F6 can cycle between them;
// nothing here auto-refocuses on blur (that would fight other regions).

// Visual order; "notifications" sits next to the toolbar bell that opens it.
const REGION_ORDER = [
  "sidebar",
  "toolbar",
  "notifications",
  "terminal",
  "approvals",
  "files",
  "diff",
] as const;

export type FocusRegion = (typeof REGION_ORDER)[number];

const FOCUSABLE = 'button, input, select, [tabindex="0"]';

/** 可成為 Tab 停留點的元素（modal focus trap 用；排除 disabled 與 tabindex=-1）。 */
const MODAL_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus trap：aria-modal 只是語意宣告，Tab 仍會把焦點帶出對話框到
 * 底層終端機；在容器內首尾邊界 wrap。呼叫端先判斷 e.key === "Tab"。
 * 參數用結構型別，React 與原生 KeyboardEvent 都可傳入。
 */
export function trapTabKey(
  e: { shiftKey: boolean; preventDefault(): void },
  container: HTMLElement,
): void {
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE),
  ).filter((el) => el.offsetParent !== null); // 略過 display:none 的元素
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !container.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Standard Escape handling for every overlay and panel: swallow the key so no
 * outer layer reacts to the same press, then run the caller's close (which is
 * responsible for restoring focus to the opener or the terminal).
 * Returns whether the key was handled.
 */
export function handleDismissKey(
  e: { key: string; preventDefault(): void; stopPropagation(): void },
  close: () => void,
): boolean {
  if (e.key !== "Escape") return false;
  e.preventDefault();
  e.stopPropagation();
  close();
  return true;
}

/** Focus the active pane's xterm hidden textarea (where typing goes). */
export function focusActiveTerminal(): void {
  const el = document.querySelector<HTMLElement>(
    '.pane[data-active="true"] .xterm-helper-textarea',
  );
  el?.focus();
}

function regionOf(el: Element | null): FocusRegion {
  const host = el?.closest<HTMLElement>("[data-focus-region]");
  const name = host?.dataset.focusRegion as FocusRegion | undefined;
  return name && REGION_ORDER.includes(name) ? name : "terminal";
}

/** The element that receives focus when a region is entered; null if region absent. */
function entryPoint(region: FocusRegion): HTMLElement | null {
  if (region === "terminal") {
    return document.querySelector<HTMLElement>(
      '.pane[data-active="true"] .xterm-helper-textarea',
    );
  }
  const host = document.querySelector<HTMLElement>(`[data-focus-region="${region}"]`);
  if (!host) return null;
  return (
    host.querySelector<HTMLElement>("[data-region-entry]") ??
    host.querySelector<HTMLElement>(FOCUSABLE)
  );
}

/** Focus a region's entry point directly; no-op when the region is absent. */
export function focusRegion(region: FocusRegion): void {
  entryPoint(region)?.focus();
}

/** Move focus to the next/previous visible region (F6 / Shift+F6). */
export function cycleFocusRegion(step: 1 | -1): void {
  const n = REGION_ORDER.length;
  const idx = REGION_ORDER.indexOf(regionOf(document.activeElement));
  for (let i = 1; i <= n; i++) {
    const next = REGION_ORDER[(idx + step * i + n * i) % n];
    const el = entryPoint(next);
    if (el) {
      el.focus();
      return;
    }
  }
}
