// Pure sidebar reordering tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/sidebar-order.test.ts
import assert from "node:assert";
import {
  beforeIdAt,
  insertIndexAt,
  moveSessionOrder,
  moveWorkspaceRelative,
  neighborWorkspaceId,
  runRange,
  stepInsertIndex,
  type OrderRow,
} from "../src/store/sidebarOrder.ts";
import { DEFAULT_WORKSPACE_ID, type Workspace } from "../src/store/workspaceGroups.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function ws(id: string, name = id): Workspace {
  return { id, name, collapsed: false };
}

function sess(id: string, workspaceId: string) {
  return { id, workspaceId };
}

function ids<S extends { id: string }>(list: S[]): string {
  return list.map((s) => s.id).join(",");
}

function inWs<S extends { id: string; workspaceId: string }>(list: S[], w: string): string {
  return ids(list.filter((s) => s.workspaceId === w));
}

// --- moveSessionOrder: within one workspace -------------------------------
{
  const base = [sess("a", "w1"), sess("b", "w1"), sess("c", "w1")];

  // The off-by-one case: computing the index against the original array would
  // land `a` before `c` instead of after it.
  const down = moveSessionOrder(base, ["a"], "w1", null);
  check("往下移到最後：a 落在 c 之後", ids(down) === "b,c,a");

  const downMid = moveSessionOrder(base, ["a"], "w1", "c");
  check("往下移一格：a 落在 b 與 c 之間", ids(downMid) === "b,a,c");

  const up = moveSessionOrder(base, ["c"], "w1", "a");
  check("往上移到最前：c 落在 a 之前", ids(up) === "c,a,b");

  const upMid = moveSessionOrder(base, ["c"], "w1", "b");
  check("往上移一格：c 落在 a 與 b 之間", ids(upMid) === "a,c,b");
}

// --- moveSessionOrder: cross-workspace ------------------------------------
{
  // Interleaved on purpose: the global array order is not grouped by workspace.
  const base = [
    sess("a1", "w1"),
    sess("b1", "w2"),
    sess("c1", "w3"),
    sess("a2", "w1"),
    sess("b2", "w2"),
    sess("c2", "w3"),
  ];

  const moved = moveSessionOrder(base, ["a1"], "w2", "b2");
  check("跨 workspace 放在指定 session 之前", inWs(moved, "w2") === "b1,a1,b2");
  check("跨 workspace 會改寫 workspaceId", moved.find((s) => s.id === "a1")!.workspaceId === "w2");
  check("第三個 workspace 的相對順序不受影響", inWs(moved, "w3") === "c1,c2");
  check("來源 workspace 只少了搬走的那個", inWs(moved, "w1") === "a2");

  const appended = moveSessionOrder(base, ["a1"], "w2", null);
  check("beforeId 為 null 時附加在該 workspace 最後", inWs(appended, "w2") === "b1,b2,a1");
  // Not the array end: appending there would jump the session past every other
  // workspace's sessions in global order.
  check("附加位置緊接在該 workspace 最後一員之後", ids(appended) === "b1,c1,a2,b2,a1,c2");

  const empty = moveSessionOrder(base, ["a1"], "w4", null);
  check("目標 workspace 是空的就接到陣列尾端", ids(empty) === "b1,c1,a2,b2,c2,a1");

  const stale = moveSessionOrder(base, ["a1"], "w2", "gone");
  check("beforeId 找不到時退回該 workspace 尾端", inWs(stale, "w2") === "b1,b2,a1");
}

// --- moveSessionOrder: identity guards ------------------------------------
{
  const base = [sess("a", "w1"), sess("b", "w1"), sess("c", "w1")];

  check("放回原位回傳同一個 array 參考", moveSessionOrder(base, ["a"], "w1", "b") === base);
  check("放到自己身上是 no-op", moveSessionOrder(base, ["a"], "w1", "a") === base);
  check(
    "放到搬移區塊的成員身上是 no-op",
    moveSessionOrder(base, ["a", "b"], "w1", "b") === base,
  );
  check("空的搬移清單是 no-op", moveSessionOrder(base, [], "w1", null) === base);
  check("id 不存在時是 no-op", moveSessionOrder(base, ["zz"], "w1", null) === base);
  check("真的有搬動就回傳新 array", moveSessionOrder(base, ["a"], "w1", null) !== base);
  // Only the workspaceId changes, but that still has to be a new array.
  const onlyTag = moveSessionOrder([sess("a", "w1")], ["a"], "w2", null);
  check("只改 workspaceId 也要回傳新 array", onlyTag[0].workspaceId === "w2");
}

// --- moveSessionOrder: multi-id blocks (split clusters) -------------------
{
  const base = [sess("a", "w1"), sess("g1", "w1"), sess("b", "w1"), sess("g2", "w1")];
  const moved = moveSessionOrder(base, ["g1", "g2"], "w1", "a");
  check("整個區塊保持連續且維持內部順序", ids(moved) === "g1,g2,a,b");
}

// --- runRange / insertIndexAt --------------------------------------------
{
  // solo, then a three-member cluster, then solo.
  const rows: OrderRow[] = [
    { id: "s1", groupId: null },
    { id: "g1", groupId: "G" },
    { id: "g2", groupId: "G" },
    { id: "g3", groupId: "G" },
    { id: "s2", groupId: null },
  ];

  check("runRange：單獨的 row 是長度 1 的 run", runRange(rows, 0).join(",") === "0,1");
  check("runRange：cluster 的第一員涵蓋整個 run", runRange(rows, 1).join(",") === "1,4");
  check("runRange：cluster 的中間員涵蓋整個 run", runRange(rows, 2).join(",") === "1,4");
  check("runRange：cluster 的最後一員涵蓋整個 run", runRange(rows, 3).join(",") === "1,4");

  // A gap inside a rendered cluster is not a real position — the next render
  // pulls the members back together.
  check("insertIndexAt：中間員的上半吸附到 cluster 頂端", insertIndexAt(rows, 2, "before") === 1);
  check("insertIndexAt：中間員的下半吸附到 cluster 底端", insertIndexAt(rows, 2, "after") === 4);
  check("insertIndexAt：單獨 row 的兩半就是自己的邊界", insertIndexAt(rows, 0, "after") === 1);

  check("beforeIdAt：指到 run 的錨點", beforeIdAt(rows, 1) === "g1");
  check("beforeIdAt：超出尾端代表 workspace 尾端", beforeIdAt(rows, rows.length) === null);
}

// --- stepInsertIndex ------------------------------------------------------
{
  const rows: OrderRow[] = [
    { id: "s1", groupId: null },
    { id: "g1", groupId: "G" },
    { id: "g2", groupId: "G" },
    { id: "s2", groupId: null },
  ];

  check("stepInsertIndex：第一列往上是 null（夾住不繞回）", stepInsertIndex(rows, 0, -1) === null);
  check("stepInsertIndex：最後一列往下是 null", stepInsertIndex(rows, 3, 1) === null);
  check("stepInsertIndex：cluster 任一員往上都夾在頂端", stepInsertIndex(rows, 2, -1) === 0);
  check("stepInsertIndex：往下一步跨過整個 cluster", stepInsertIndex(rows, 0, 1) === 3);
  check("stepInsertIndex：cluster 整團往下跨過下一列", stepInsertIndex(rows, 1, 1) === 4);
}

// --- moveWorkspaceRelative ------------------------------------------------
{
  const list = [ws(DEFAULT_WORKSPACE_ID, "D"), ws("w1"), ws("w2")];

  check(
    "workspace 移到目標之前",
    ids(moveWorkspaceRelative(list, "w2", "w1", "before")) === "default,w2,w1",
  );
  check(
    "workspace 移到目標之後",
    ids(moveWorkspaceRelative(list, DEFAULT_WORKSPACE_ID, "w1", "after")) === "w1,default,w2",
  );
  // The default workspace is only special by id (deletability), never by index.
  check(
    "預設 workspace 可以離開第 0 位",
    moveWorkspaceRelative(list, DEFAULT_WORKSPACE_ID, "w2", "after")[2].id ===
      DEFAULT_WORKSPACE_ID,
  );
  check("拖到自己身上是 no-op", moveWorkspaceRelative(list, "w1", "w1", "before") === list);
  check("目標不存在是 no-op", moveWorkspaceRelative(list, "w1", "nope", "before") === list);
  check("來源不存在是 no-op", moveWorkspaceRelative(list, "nope", "w1", "before") === list);
  check(
    "移到原本就在的位置回傳同一個參考",
    moveWorkspaceRelative(list, "w1", "w2", "before") === list,
  );
}

// --- neighborWorkspaceId --------------------------------------------------
{
  const list = [ws("a"), ws("b"), ws("c")];
  check("neighborWorkspaceId：往下取下一個", neighborWorkspaceId(list, "a", 1) === "b");
  check("neighborWorkspaceId：往上取上一個", neighborWorkspaceId(list, "c", -1) === "b");
  check("neighborWorkspaceId：第一個往上夾住", neighborWorkspaceId(list, "a", -1) === null);
  check("neighborWorkspaceId：最後一個往下夾住", neighborWorkspaceId(list, "c", 1) === null);
  check("neighborWorkspaceId：不存在的 id 回 null", neighborWorkspaceId(list, "zz", 1) === null);
}

console.log(`\nsidebar-order: ${passed} checks passed`);
