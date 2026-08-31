// Pointer-driven drag state for the sidebar, shared by SessionSidebar (the
// provider) and the rows that start or receive a drag.
//
// Why pointer events instead of HTML5 drag-and-drop: on Windows, Tauri
// registers a native IDropTarget on the WebView2 window whenever
// `dragDropEnabled` is true (the default). That handler intercepts OLE
// drag-drop at the OS level and swallows *every* drag reaching the webview --
// including drags between two DOM elements on the same page. `dragstart` fires,
// but `dragover`/`drop` never arrive, so an HTML5 drop target is simply dead.
// Tauri's own config docs say it: "Disabling it is required to use HTML5 drag
// and drop on the frontend on Windows."
//
// Turning `dragDropEnabled` off is not an option, because the same handler is
// what feeds the terminal's drag-a-file-in-to-paste-its-path feature (see
// ipc/fileDrop.ts), and the HTML5 fallback there yields a file name rather than
// the absolute path the PTY needs -- tauri#5941's catch-22.
//
// Pointer events alone are NOT enough on Windows, though, and the first version
// of this module found that out the hard way: without pointer capture WebView2
// still starts its own OLE drag the moment a press moves, Tauri's IDropTarget
// takes over, paints a "not-allowed" cursor, and the pointermove stream dies --
// so the indicator never appeared and nothing ever committed. Taking capture on
// the source element pins the pointer sequence to us and keeps the native layer
// out of it. `touch-action: none` on the rows (see SessionSidebar.css) is the
// other half: the sidebar list scrolls, so WebView2 would otherwise read a
// vertical drag as a scroll gesture and fire pointercancel instead. The two
// working drags in this app -- SidebarResizer and SplitResizers -- both do
// exactly this pair, which is why they work on Windows and this did not.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { autoScrollStep } from "./autoScroll";
import type { DragKind } from "./dropPosition";

/** Pointer travel before a press counts as a drag rather than a click. A
 *  sidebar row is both a button and a drag source, so every click starts as a
 *  potential drag; 5px is the usual desktop figure. */
export const DRAG_THRESHOLD_PX = 5;

/** The active drag's payload -- the pointer-event equivalent of the two
 *  dataTransfer MIME types, and the same thing `dragKind` used to report. */
export interface ActiveDrag {
  kind: DragKind;
  id: string;
  /** The workspace a dragged session started in; null for a workspace drag.
   *  Sessions may only be reordered inside their own workspace, so every group
   *  compares this against its own id and declines to be a target otherwise.
   *  The store's reorderSession still supports the cross-workspace move (the
   *  keyboard path shares it) -- the restriction is this UI's, not the API's. */
  sourceWorkspaceId: string | null;
}

/** What one workspace group exposes to the controller. Mirrors the old
 *  onDragOver / onDrop / clearDrag trio, minus the DragEvent. */
export interface GroupDropHandlers {
  /** The group's own element, for hit-testing the pointer. */
  element: () => HTMLElement | null;
  /** Pointer moved over this group: paint the indicator. */
  over: (clientY: number, target: Element | null, drag: ActiveDrag) => void;
  /** Pointer released over this group: commit. */
  drop: (drag: ActiveDrag) => void;
  /** Pointer left this group or the drag ended: clear the indicator. */
  clear: () => void;
}

interface DragContextValue {
  /** Non-null once a press has crossed the movement threshold. */
  active: ActiveDrag | null;
  /** Arm a potential drag from a row's onPointerDown. */
  startDrag: (
    kind: DragKind,
    id: string,
    sourceWorkspaceId: string | null,
    e: React.PointerEvent,
  ) => void;
  /** Register a group's drop handlers; called by each WorkspaceGroup. */
  registerGroup: (id: string, handlers: GroupDropHandlers) => () => void;
  /** SessionSidebar attaches this to its <aside>. The controller needs a live
   *  handle for the scrolling list and for the `data-dragging` flag, and it
   *  cannot render a wrapper of its own: `.app > .sidebar` is a direct-child
   *  selector and the aside is a flex item of `.app`, so an extra div would
   *  break both the z-index rules and the sidebar's width. */
  rootRef: React.RefObject<HTMLElement | null>;
}

const DragContext = createContext<DragContextValue | null>(null);

/** Rows call this to start drags and read the active one. */
export function useSidebarDragContext(): DragContextValue {
  const ctx = useContext(DragContext);
  if (!ctx) throw new Error("useSidebarDragContext used outside SidebarDragProvider");
  return ctx;
}

interface Pending {
  kind: DragKind;
  id: string;
  sourceWorkspaceId: string | null;
  startX: number;
  startY: number;
  pointerId: number;
  /** The element the press landed on; the pointer-capture holder once started. */
  sourceEl: HTMLElement;
  started: boolean;
  /** The group currently painting an indicator, so we can clear exactly one. */
  lastGroup: string | null;
}

export function SidebarDragProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const groups = useRef(new Map<string, GroupDropHandlers>());
  const rootRef = useRef<HTMLElement | null>(null);

  const registerGroup = useCallback((id: string, handlers: GroupDropHandlers) => {
    groups.current.set(id, handlers);
    return () => {
      groups.current.delete(id);
    };
  }, []);

  const startDrag = useCallback(
    (kind: DragKind, id: string, sourceWorkspaceId: string | null, e: React.PointerEvent) => {
      // Left button only: a right-click must still reach the context menu.
      if (e.button !== 0) return;
      pending.current = {
        kind,
        id,
        sourceWorkspaceId,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        sourceEl: e.currentTarget as HTMLElement,
        started: false,
        lastGroup: null,
      };
    },
    [],
  );

  useEffect(() => {
    /** Clear whichever group last painted an indicator. */
    const clearLast = (p: Pending) => {
      if (p.lastGroup) groups.current.get(p.lastGroup)?.clear();
      p.lastGroup = null;
    };

    /** The group whose element contains the point, if any. Measured live: the
     *  sidebar scrolls during a drag, so a cached rect would send the drop to
     *  whatever group used to be under the cursor. */
    const groupAt = (x: number, y: number): [string, GroupDropHandlers] | null => {
      for (const [id, h] of groups.current) {
        const el = h.element();
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return [id, h];
      }
      return null;
    };

    const listEl = (): HTMLElement | null =>
      rootRef.current?.querySelector<HTMLElement>(".session-list") ?? null;

    /** Paint the indicator for a pointer position. Shared by the move handler
     *  and the auto-scroll loop, which has to re-hit-test as rows slide past a
     *  stationary pointer. */
    const paint = (p: Pending, x: number, y: number) => {
      const drag: ActiveDrag = {
        kind: p.kind,
        id: p.id,
        sourceWorkspaceId: p.sourceWorkspaceId,
      };
      const hit = groupAt(x, y);
      if (!hit) {
        clearLast(p);
        return;
      }
      const [id, handlers] = hit;
      if (p.lastGroup && p.lastGroup !== id) groups.current.get(p.lastGroup)?.clear();
      p.lastGroup = id;
      // elementFromPoint rather than e.target: with pointer capture held,
      // e.target is always the source row, so the point is the only truth about
      // what sits under the cursor.
      handlers.over(y, document.elementFromPoint(x, y), drag);
    };

    // --- auto-scroll ------------------------------------------------------
    // Capture keeps the pointer stream ours, which also means the list will not
    // scroll itself any more. Drive it from a rAF loop off the latest pointer
    // position, so speed is frame-bound rather than event-rate-bound.
    let rafId = 0;
    let lastX = 0;
    let lastY = 0;
    const tick = () => {
      rafId = 0;
      const p = pending.current;
      const list = listEl();
      if (!p || !p.started || !list) return;
      const step = autoScrollStep(lastY, list.getBoundingClientRect());
      if (step !== 0) {
        list.scrollTop += step;
        // Rows moved under a pointer that did not: re-derive the drop line, or
        // it would keep pointing at whatever row used to be there.
        paint(p, lastX, lastY);
      }
      rafId = requestAnimationFrame(tick);
    };
    const startAutoScroll = () => {
      if (!rafId) rafId = requestAnimationFrame(tick);
    };
    const stopAutoScroll = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const swallowClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.started) {
        const dx = e.clientX - p.startX;
        const dy = e.clientY - p.startY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        p.started = true;
        // Capture at the threshold, not at pointerdown: a press that stays put
        // is a click, and stealing the pointer for it would break the buttons
        // inside the row.
        try {
          p.sourceEl.setPointerCapture(p.pointerId);
        } catch {
          // Element already detached, or capture refused -- the window-level
          // listeners below still work, just without native-drag immunity.
        }
        setActive({ kind: p.kind, id: p.id, sourceWorkspaceId: p.sourceWorkspaceId });
        rootRef.current?.setAttribute("data-dragging", "true");
        startAutoScroll();
      }
      lastX = e.clientX;
      lastY = e.clientY;
      paint(p, e.clientX, e.clientY);
      // Unconditionally, including over no group: any gesture left to its
      // default is an opening for WebView2 to start a native drag.
      e.preventDefault();
    };

    const finish = (commit: boolean) => {
      const p = pending.current;
      // Clearing this first is load-bearing, not tidiness: releasePointerCapture
      // below dispatches lostpointercapture synchronously, and onLostCapture
      // would otherwise re-enter finish() and commit the drop a second time.
      // With pending already null it bails on its own `!p` guard.
      pending.current = null;
      stopAutoScroll();
      setActive(null);
      rootRef.current?.removeAttribute("data-dragging");
      if (!p) return;
      if (p.started) {
        try {
          p.sourceEl.releasePointerCapture(p.pointerId);
        } catch {
          // Already released, e.g. the pointer is gone -- nothing to undo.
        }
      }
      const target = p.lastGroup ? groups.current.get(p.lastGroup) : null;
      clearLast(p);
      if (!p.started) return;
      // A completed drag still ends with a `click` on the origin row, which
      // would activate the session the user was only moving. pointerup runs
      // before click, so React state cannot gate it -- swallow it here.
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      if (commit && target) {
        target.drop({ kind: p.kind, id: p.id, sourceWorkspaceId: p.sourceWorkspaceId });
      }
    };

    const onUp = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      finish(true);
    };

    const onCancel = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      finish(false);
    };

    // Losing capture mid-drag is not the user cancelling -- it happens when the
    // captured element is re-rendered out from under us. The pointer is still
    // down and the indicator still names a real target, so honour it rather
    // than dropping the gesture on the floor.
    const onLostCapture = (e: Event) => {
      const p = pending.current;
      const pe = e as PointerEvent;
      if (!p || !p.started || pe.pointerId !== p.pointerId) return;
      finish(p.lastGroup !== null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pending.current) finish(false);
    };

    // Capture phase: the terminal and xterm's own handlers sit downstream, and
    // a drag in progress must outrank them.
    const opts = { capture: true } as const;
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onCancel, opts);
    window.addEventListener("lostpointercapture", onLostCapture, opts);
    window.addEventListener("keydown", onKey);
    return () => {
      stopAutoScroll();
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onCancel, opts);
      window.removeEventListener("lostpointercapture", onLostCapture, opts);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, []);

  const value = useMemo(
    () => ({ active, startDrag, registerGroup, rootRef }),
    [active, startDrag, registerGroup],
  );
  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}
