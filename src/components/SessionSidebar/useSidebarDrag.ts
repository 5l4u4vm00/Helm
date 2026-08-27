// Pointer-event drag controller for the sidebar (sessions between workspaces,
// workspaces between each other).
//
// Deliberately NOT HTML5 drag-and-drop: on Windows, Tauri's native drop handler
// swallows in-page drag events entirely, so `onDrop` never fires. The full
// reasoning — and why turning that handler off is not an option here — lives at
// the top of store/sidebarDrag.ts. Pointer events bypass the native handler, so
// the sidebar works on Windows while the terminal keeps its OS file drops.
//
// The geometry and the "is this a drag yet" judgement are pure functions in
// that module; this hook owns only the browser-facing parts: capture, live
// measurement, and cleanup.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  exceedsDragThreshold,
  resolveSessionDrop,
  resolveWorkspaceDrop,
  type DragKind,
  type DragRect,
  type DropTarget,
} from "../../store/sidebarDrag";

/** Live drag state the sidebar renders feedback from. */
export interface SidebarDragState {
  kind: DragKind;
  /** Session id or workspace id, depending on `kind`. */
  id: string;
  target: DropTarget | null;
}

export interface SidebarDragApi {
  /** Non-null once a press has crossed the movement threshold. */
  drag: SidebarDragState | null;
  /** Call from a row's onPointerDown to arm a potential drag. */
  startDrag: (kind: DragKind, id: string, e: React.PointerEvent) => void;
}

interface Pending {
  kind: DragKind;
  id: string;
  startX: number;
  startY: number;
  pointerId: number;
  /** The element that captured the pointer, so we can release it. */
  origin: Element;
  started: boolean;
  /** Latest resolved drop target. Lives on the ref, not React state, because
   *  `pointerup` must read the final value synchronously — a state mirror would
   *  either lag a render behind or mean writing a ref during render. */
  target: DropTarget | null;
}

/**
 * @param listRef  the scroll container holding the workspace groups
 * @param onDropSession   commit: move a session into a workspace
 * @param onDropWorkspace commit: move a workspace into a gap index
 */
export function useSidebarDrag(
  listRef: React.RefObject<HTMLDivElement | null>,
  onDropSession: (sessionId: string, workspaceId: string) => void,
  onDropWorkspace: (workspaceId: string, toIndex: number) => void,
): SidebarDragApi {
  const [drag, setDrag] = useState<SidebarDragState | null>(null);
  const pending = useRef<Pending | null>(null);

  /**
   * Measure the workspace groups in DOM order, in viewport coordinates.
   *
   * Re-measured on every move rather than cached at drag start: the sidebar
   * scrolls during a drag, and a cached rect would send the drop to whatever
   * group used to be under the cursor.
   */
  const measure = useCallback((): DragRect[] => {
    const nodes = listRef.current?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? [];
    return [...nodes].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.workspaceId ?? "", top: r.top, bottom: r.bottom };
    });
  }, [listRef]);

  const startDrag = useCallback((kind: DragKind, id: string, e: React.PointerEvent) => {
    // Left button only; a right-click must still reach the context menu, and a
    // middle-click must not silently reorder anything.
    if (e.button !== 0) return;
    pending.current = {
      kind,
      id,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      origin: e.currentTarget,
      started: false,
      target: null,
    };
  }, []);

  useEffect(() => {
    const swallowClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.started) {
        if (!exceedsDragThreshold(p.startX, p.startY, e.clientX, e.clientY)) return;
        p.started = true;
        // Capture so the drag survives the pointer leaving the row — without
        // it, a fast drag drops the moment the cursor outruns the element.
        try {
          p.origin.setPointerCapture(p.pointerId);
        } catch {
          // Element already gone (row re-rendered mid-press); the window
          // listeners below still carry the drag to completion.
        }
      }
      const groups = measure();
      const target =
        p.kind === "session"
          ? resolveSessionDrop(e.clientY, groups)
          : resolveWorkspaceDrop(e.clientY, groups);
      p.target = target;
      setDrag({ kind: p.kind, id: p.id, target });
      // Suppress text selection / native affordances once we own the gesture.
      e.preventDefault();
    };

    const finish = () => {
      const p = pending.current;
      pending.current = null;
      setDrag(null);
      if (!p) return;
      if (p.started) {
        try {
          p.origin.releasePointerCapture(p.pointerId);
        } catch {
          // Capture was never taken or the element is gone; nothing to release.
        }
        // A completed drag still ends with a `click` on the origin row, which
        // would activate the session the user was only moving. React state is
        // no help here — `pointerup` runs before `click`, so the drag flag is
        // already cleared by the time the row's handler sees it. Swallow the
        // one click at the capture phase instead.
        window.addEventListener("click", swallowClick, { capture: true, once: true });
      }
      if (!p.started || !p.target) return;
      if (p.kind === "session" && p.target.kind === "into") {
        onDropSession(p.id, p.target.workspaceId);
      } else if (p.kind === "workspace" && p.target.kind === "before") {
        onDropWorkspace(p.id, p.target.index);
      }
    };

    const onUp = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      finish();
    };

    // Esc cancels mid-drag, matching every other dismissable interaction.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !pending.current) return;
      const p = pending.current;
      pending.current = null;
      setDrag(null);
      if (p.started) {
        try {
          p.origin.releasePointerCapture(p.pointerId);
        } catch {
          // See above: nothing to release.
        }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer (OS gesture, window losing the device) must not leave
    // a drag stuck on screen.
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
      // The `once` click guard may still be armed if the effect re-runs
      // between pointerup and the click that follows it.
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, [measure, onDropSession, onDropWorkspace]);

  return { drag, startDrag };
}
