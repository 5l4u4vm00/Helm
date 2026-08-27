// Pointer-driven drag state for the sidebar, shared by SessionSidebar (the
// provider) and the rows that start or receive a drag.
//
// Why pointer events instead of HTML5 drag-and-drop: on Windows, Tauri
// registers a native IDropTarget on the WebView2 window whenever
// `dragDropEnabled` is true (the default). That handler intercepts OLE
// drag-drop at the OS level and swallows *every* drag reaching the webview —
// including drags between two DOM elements on the same page. `dragstart` fires,
// but `dragover`/`drop` never arrive, so an HTML5 drop target is simply dead.
// Tauri's own config docs say it: "Disabling it is required to use HTML5 drag
// and drop on the frontend on Windows."
//
// Turning `dragDropEnabled` off is not an option, because the same handler is
// what feeds the terminal's drag-a-file-in-to-paste-its-path feature (see
// ipc/fileDrop.ts), and the HTML5 fallback there yields a file name rather than
// the absolute path the PTY needs — tauri#5941's catch-22.
//
// So this module reproduces exactly what dataTransfer used to carry (which item
// is being dragged) while dropPosition.ts keeps owning the geometry. The drop
// decisions themselves are unchanged; only the transport is.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DragKind } from "./dropPosition";

/** Pointer travel before a press counts as a drag rather than a click. A
 *  sidebar row is both a button and a drag source, so every click starts as a
 *  potential drag; 5px is the usual desktop figure. */
export const DRAG_THRESHOLD_PX = 5;

/** The active drag's payload — the pointer-event equivalent of the two
 *  dataTransfer MIME types, and the same thing `dragKind` used to report. */
export interface ActiveDrag {
  kind: DragKind;
  id: string;
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
  startDrag: (kind: DragKind, id: string, e: React.PointerEvent) => void;
  /** Register a group's drop handlers; called by each WorkspaceGroup. */
  registerGroup: (id: string, handlers: GroupDropHandlers) => () => void;
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
  startX: number;
  startY: number;
  pointerId: number;
  started: boolean;
  /** The group currently painting an indicator, so we can clear exactly one. */
  lastGroup: string | null;
}

export function SidebarDragProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const groups = useRef(new Map<string, GroupDropHandlers>());

  const registerGroup = useCallback((id: string, handlers: GroupDropHandlers) => {
    groups.current.set(id, handlers);
    return () => {
      groups.current.delete(id);
    };
  }, []);

  const startDrag = useCallback((kind: DragKind, id: string, e: React.PointerEvent) => {
    // Left button only: a right-click must still reach the context menu.
    if (e.button !== 0) return;
    pending.current = {
      kind,
      id,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      started: false,
      lastGroup: null,
    };
  }, []);

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
        setActive({ kind: p.kind, id: p.id });
      }
      const drag: ActiveDrag = { kind: p.kind, id: p.id };
      const hit = groupAt(e.clientX, e.clientY);
      if (!hit) {
        clearLast(p);
        return;
      }
      const [id, handlers] = hit;
      if (p.lastGroup && p.lastGroup !== id) groups.current.get(p.lastGroup)?.clear();
      p.lastGroup = id;
      // elementFromPoint rather than e.target: no pointer capture is taken, so
      // e.target is whatever sits under the cursor anyway, but going through
      // the hit-test keeps this correct if capture is ever added.
      handlers.over(e.clientY, document.elementFromPoint(e.clientX, e.clientY), drag);
      e.preventDefault();
    };

    const finish = (commit: boolean) => {
      const p = pending.current;
      pending.current = null;
      setActive(null);
      if (!p) return;
      const target = p.lastGroup ? groups.current.get(p.lastGroup) : null;
      clearLast(p);
      if (!p.started) return;
      // A completed drag still ends with a `click` on the origin row, which
      // would activate the session the user was only moving. pointerup runs
      // before click, so React state cannot gate it — swallow it here.
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      if (commit && target) target.drop({ kind: p.kind, id: p.id });
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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pending.current) finish(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, []);

  const value = useMemo(
    () => ({ active, startDrag, registerGroup }),
    [active, startDrag, registerGroup],
  );
  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}
