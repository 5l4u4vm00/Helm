// Pure sidebar drag helper tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/sidebar-drag.test.ts
import assert from "node:assert";
import {
  DRAG_THRESHOLD_PX,
  exceedsDragThreshold,
  moveWorkspaceOrder,
  resolveSessionDrop,
  resolveWorkspaceDrop,
  type DragRect,
} from "../src/store/sidebarDrag.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function rect(id: string, top: number, bottom: number): DragRect {
  return { id, top, bottom };
}

// --- exceedsDragThreshold ---
{
  check("a press that has not moved is not a drag", !exceedsDragThreshold(100, 100, 100, 100));
  check(
    "a jitter below the threshold is not a drag",
    !exceedsDragThreshold(100, 100, 102, 102),
  );
  check(
    "exactly the threshold counts as a drag",
    exceedsDragThreshold(100, 100, 100, 100 + DRAG_THRESHOLD_PX),
  );
  check("a clear horizontal move is a drag", exceedsDragThreshold(100, 100, 120, 100));
  check("direction does not matter", exceedsDragThreshold(100, 100, 80, 100));
  check(
    "diagonal travel accumulates across both axes",
    exceedsDragThreshold(0, 0, 4, 4), // 5.66px > 5
  );
  check("a custom threshold is honored", !exceedsDragThreshold(0, 0, 8, 0, 20));
}

// --- resolveSessionDrop ---
{
  const groups = [rect("a", 0, 100), rect("b", 100, 200), rect("c", 200, 260)];

  /** The targeted workspace id, or null when the point hits no group. */
  const into = (y: number, list: DragRect[] = groups) => {
    const t = resolveSessionDrop(y, list);
    return t?.kind === "into" ? t.workspaceId : null;
  };

  check("a point inside the first group targets it", into(50) === "a");
  check("a point inside a middle group targets it", into(150) === "b");
  check("a group's top edge belongs to that group", into(100) === "b");
  check("a group's bottom edge belongs to the next group", into(200) === "c");
  check("above every group is not a target", resolveSessionDrop(-10, groups) === null);
  check("below every group is not a target", resolveSessionDrop(999, groups) === null);
  check("an empty sidebar has no target", resolveSessionDrop(50, []) === null);
}

// A collapsed group still occupies a rect (header only) and must stay a target:
// dragging into a collapsed workspace is exactly why the whole group is measured.
{
  const groups = [rect("open", 0, 120), rect("collapsed", 120, 144)];
  const t = resolveSessionDrop(130, groups);
  check(
    "a collapsed group is still a drop target",
    t?.kind === "into" && t.workspaceId === "collapsed",
  );
}

// --- resolveWorkspaceDrop ---
{
  const groups = [rect("a", 0, 100), rect("b", 100, 200), rect("c", 200, 300)];

  const idx = (y: number) => {
    const t = resolveWorkspaceDrop(y, groups);
    return t?.kind === "before" ? t.index : -1;
  };

  check("above the first group inserts at 0", idx(-50) === 0);
  check("the top half of the first group inserts before it", idx(10) === 0);
  check("the bottom half of the first group inserts after it", idx(90) === 1);
  check("the midpoint itself belongs to the lower half", idx(50) === 1);
  check("the top half of a middle group inserts before it", idx(120) === 1);
  check("the bottom half of the last group appends", idx(280) === 3);
  check("below every group appends", idx(999) === 3);
  check("an empty list has no gap", resolveWorkspaceDrop(0, []) === null);
}

// --- moveWorkspaceOrder ---
{
  const list = ["a", "b", "c", "d"];

  check(
    "moving the first item to the end",
    moveWorkspaceOrder(list, 0, 4).join("") === "bcda",
  );
  check(
    "moving the last item to the front",
    moveWorkspaceOrder(list, 3, 0).join("") === "dabc",
  );
  check(
    "moving down by one lands after the neighbour",
    moveWorkspaceOrder(list, 0, 2).join("") === "bacd",
  );
  check(
    "moving up by one lands before the neighbour",
    moveWorkspaceOrder(list, 2, 1).join("") === "acbd",
  );
  check(
    "a middle-to-middle move keeps the rest in order",
    moveWorkspaceOrder(list, 1, 4).join("") === "acdb",
  );

  // The insertion index is interpreted against the pre-removal list, so both
  // gaps adjacent to the dragged item mean "stay put" — and must not churn the
  // store or the persisted order.
  check("dropping into its own slot is a no-op", moveWorkspaceOrder(list, 1, 1) === list);
  check("dropping just below itself is a no-op", moveWorkspaceOrder(list, 1, 2) === list);

  check("an out-of-range source is a no-op", moveWorkspaceOrder(list, 9, 0) === list);
  check("a negative source is a no-op", moveWorkspaceOrder(list, -1, 0) === list);
  check("an out-of-range destination is a no-op", moveWorkspaceOrder(list, 0, 9) === list);
  check("the input array is never mutated", list.join("") === "abcd");
  // Only two gaps exist around a lone item, and both are adjacent to it.
  check("a single-item list cannot reorder", moveWorkspaceOrder(["a"], 0, 1).join("") === "a");
}

console.log(`\n${passed} checks passed`);
