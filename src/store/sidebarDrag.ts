// Pure sidebar drag-and-drop decisions (no React / DOM / Zustand deps).
//
// Why this exists at all, rather than HTML5 DnD: Tauri 2 on Windows registers a
// native IDropTarget on the WebView2 window whenever `dragDropEnabled` is true
// (the default). That handler intercepts OLE drag-drop at the OS level and
// swallows *every* drag reaching the webview — including drags between two DOM
// elements on the same page. `dragstart` still fires, but `dragover`/`drop`
// never arrive, so an HTML5 drop target is simply dead on Windows. Tauri's own
// config docs say it plainly: "Disabling it is required to use HTML5 drag and
// drop on the frontend on Windows."
//
// Turning `dragDropEnabled` off is not an option here: it also unregisters the
// handler behind `onDragDropEvent`, which is what feeds the terminal's
// drag-a-file-in-to-paste-its-path feature (see ipc/fileDrop.ts). The HTML5
// fallback for that is worse than useless on WebView2 — it yields a file name,
// not the absolute path the PTY needs. That trade-off is tauri#5941's catch-22.
//
// So the sidebar uses pointer events, which never touch the native drop
// handler, and both features coexist. This module holds the parts worth
// testing: when a press becomes a drag, and which slot a Y coordinate targets.

/** What a drag is carrying. Sessions move between workspaces; workspaces reorder. */
export type DragKind = "session" | "workspace";

/**
 * A drop target resolved from the pointer position.
 *
 * `into` is a session landing inside a workspace; `before` is a workspace
 * being inserted ahead of the workspace at `index` (an index equal to the list
 * length means "past the last one", i.e. append).
 */
export type DropTarget =
  | { kind: "into"; workspaceId: string }
  | { kind: "before"; index: number };

/** One candidate row, measured in viewport coordinates by the caller. */
export interface DragRect {
  id: string;
  top: number;
  bottom: number;
}

/**
 * Pointer travel (px) before a press counts as a drag rather than a click.
 *
 * A sidebar row is both a button and a drag handle, so every click starts as a
 * potential drag. Too small and a click with a shaky hand silently reorders the
 * list; too large and dragging feels stuck. 5px is the usual desktop figure and
 * matches what the pane resizers already tolerate.
 */
export const DRAG_THRESHOLD_PX = 5;

/** Whether the pointer has moved far enough from the press point to be a drag. */
export function exceedsDragThreshold(
  startX: number,
  startY: number,
  x: number,
  y: number,
  threshold: number = DRAG_THRESHOLD_PX,
): boolean {
  const dx = x - startX;
  const dy = y - startY;
  // Squared distance: same ordering, no sqrt, and no float fuzz at the boundary.
  return dx * dx + dy * dy >= threshold * threshold;
}

/**
 * Which workspace a dragged session is over.
 *
 * Rects are the whole workspace group (header + rows), so a collapsed group is
 * still a target — that is the point of measuring the group rather than the
 * session list. Returns null past the ends rather than clamping: dropping into
 * dead space below the last group should cancel, not silently pick the last
 * workspace the cursor happened to pass.
 */
export function resolveSessionDrop(y: number, groups: DragRect[]): DropTarget | null {
  for (const g of groups) {
    if (y >= g.top && y < g.bottom) return { kind: "into", workspaceId: g.id };
  }
  return null;
}

/**
 * Which gap a dragged workspace would land in.
 *
 * Each group claims the gap above it until its own midpoint, then the gap
 * below — so the insertion line follows the cursor's half of the row, which is
 * what makes reordering feel predictable. Above the first group means index 0;
 * below the last means append (index === length).
 */
export function resolveWorkspaceDrop(y: number, groups: DragRect[]): DropTarget | null {
  if (groups.length === 0) return null;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (y < (g.top + g.bottom) / 2) return { kind: "before", index: i };
  }
  return { kind: "before", index: groups.length };
}

/**
 * Move the workspace at `from` so it sits at slot `to` in the *original*
 * indexing — i.e. `to` is the insertion point resolved before removal, which is
 * how resolveWorkspaceDrop reports it. Removing first would shift every slot
 * after `from` by one and drop the item one position short.
 *
 * Returns the same array reference when the move is a no-op (out of range, or
 * landing where it already is) so callers can skip a pointless store write.
 */
export function moveWorkspaceOrder<T>(list: readonly T[], from: number, to: number): readonly T[] {
  if (from < 0 || from >= list.length) return list;
  if (to < 0 || to > list.length) return list;
  // Dropping into either gap touching the item leaves the order unchanged.
  if (to === from || to === from + 1) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}
