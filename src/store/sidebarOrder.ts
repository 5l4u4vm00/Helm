// Pure reordering for the sidebar's two ordered arrays (no React/Zustand/DOM;
// unit-tested in tests/sidebar-order.test.ts). This is the write-side
// counterpart of workspaceGroups.ts, which only reads the same ordering.
//
// There is no `order` field anywhere: a workspace's position IS its index in
// `workspaces[]`, and a session's position inside its workspace IS its index in
// the global `sessions[]` filtered by workspaceId. So reordering is array
// surgery, and the one rule that makes it correct is: remove the moving block
// first, then compute the insertion index against the SHORTENED array.
// Computing it against the original array is off by one for every downward
// move — the classic splice bug, and invisible in a two-row demo.
import type { Workspace } from "./workspaceGroups";

interface Positioned {
  id: string;
  workspaceId: string;
}

/** A rendered sidebar row, as clusterBySplitGroup produced it. */
export interface OrderRow {
  id: string;
  groupId: string | null;
}

/**
 * Move `ids` (one session, or a whole split-cluster run) so they sit
 * immediately before `beforeId`, retagged into `targetWorkspaceId`.
 * `beforeId === null` means "end of that workspace".
 *
 * Sessions outside the moving block keep their relative order by construction:
 * they all come out of one order-preserving partition and exactly one block is
 * spliced back in.
 */
export function moveSessionOrder<S extends Positioned>(
  sessions: S[],
  ids: readonly string[],
  targetWorkspaceId: string,
  beforeId: string | null,
): S[] {
  const moving = new Set(ids);
  if (moving.size === 0) return sessions;
  // Dropping onto a member of the moving block is a no-op, not an insertion
  // into itself.
  if (beforeId !== null && moving.has(beforeId)) return sessions;

  const block: S[] = [];
  const rest: S[] = [];
  for (const s of sessions) (moving.has(s.id) ? block : rest).push(s);
  if (block.length === 0) return sessions;

  // A stale beforeId (the row was closed mid-drag) degrades to end-of-workspace
  // rather than throwing away the gesture.
  let at = beforeId === null ? -1 : rest.findIndex((s) => s.id === beforeId);
  if (at < 0) at = endOfWorkspace(rest, targetWorkspaceId);

  const retagged = block.map((s) =>
    s.workspaceId === targetWorkspaceId ? s : { ...s, workspaceId: targetWorkspaceId },
  );
  const next = [...rest.slice(0, at), ...retagged, ...rest.slice(at)];
  // Same reference when nothing actually moved: sessionsPersistEqual compares
  // positionally, so a fresh array on a stray drop would schedule a pointless
  // sessions.json write and re-render the whole sidebar.
  return sameOrder(sessions, next) ? sessions : next;
}

/**
 * One past the workspace's last member — deliberately not the array end.
 * Appending to the array end would jump the session past every other
 * workspace's sessions in global order: invisible now, but it silently
 * corrupts the *next* move within that workspace.
 */
function endOfWorkspace<S extends Positioned>(rest: S[], workspaceId: string): number {
  let last = -1;
  for (let i = 0; i < rest.length; i += 1) if (rest[i].workspaceId === workspaceId) last = i;
  return last < 0 ? rest.length : last + 1;
}

function sameOrder<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Move `dragId` before/after `targetId`. Workspaces always have a target (the
 *  list is never empty), so this takes target + edge rather than the session
 *  flavour's nullable beforeId. */
export function moveWorkspaceRelative(
  list: Workspace[],
  dragId: string,
  targetId: string,
  edge: "before" | "after",
): Workspace[] {
  if (dragId === targetId) return list;
  const item = list.find((w) => w.id === dragId);
  if (!item) return list;
  const rest = list.filter((w) => w.id !== dragId);
  const at = rest.findIndex((w) => w.id === targetId);
  if (at < 0) return list;
  const insertAt = edge === "before" ? at : at + 1;
  const next = [...rest.slice(0, insertAt), item, ...rest.slice(insertAt)];
  return sameOrder(list, next) ? list : next;
}

/** Keyboard neighbour; null at the edge. Moves clamp, never wrap — a held key
 *  that teleports a workspace from bottom to top is not a reorder gesture. */
export function neighborWorkspaceId(
  list: Workspace[],
  id: string,
  delta: 1 | -1,
): string | null {
  const i = list.findIndex((w) => w.id === id);
  return i < 0 ? null : (list[i + delta]?.id ?? null);
}

/** [start, end) of the split-cluster run containing rows[i]. */
export function runRange(rows: readonly OrderRow[], i: number): [number, number] {
  const g = rows[i]?.groupId ?? null;
  if (g === null) return [i, i + 1];
  let start = i;
  while (start > 0 && rows[start - 1].groupId === g) start -= 1;
  let end = i + 1;
  while (end < rows.length && rows[end].groupId === g) end += 1;
  return [start, end];
}

/**
 * Insertion index for a pointer in half `half` of row `i`, snapped to cluster
 * boundaries: a gap *inside* a rendered cluster is not a real position, because
 * clusterBySplitGroup pulls the members back together on the next render and
 * the row lands somewhere the user never pointed at.
 */
export function insertIndexAt(
  rows: readonly OrderRow[],
  i: number,
  half: "before" | "after",
): number {
  const [start, end] = runRange(rows, i);
  return half === "before" ? start : end;
}

/** Insertion index for "move the run at `i` one step `delta`"; null at the edge. */
export function stepInsertIndex(
  rows: readonly OrderRow[],
  i: number,
  delta: 1 | -1,
): number | null {
  const [start, end] = runRange(rows, i);
  if (delta === -1) return start === 0 ? null : runRange(rows, start - 1)[0];
  return end >= rows.length ? null : runRange(rows, end)[1];
}

/**
 * Insertion index -> the id to insert before (null = end of the workspace).
 * Every index this module produces is a run boundary, so the row it names is
 * always a run *anchor* — which is exactly what makes the global-array splice
 * and the visual insertion line agree.
 */
export function beforeIdAt(rows: readonly OrderRow[], index: number): string | null {
  return rows[index]?.id ?? null;
}
