// Split 版面樹純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/layout-tree.test.ts
import assert from "node:assert";
import {
  MAX_RATIO,
  clampRatio,
  collectSessionIds,
  computeLayout,
  findLeafBySession,
  findTreeBySession,
  hydrateSnapshotNode,
  leaf,
  leafCount,
  removeLeafBySession,
  setRatio,
  siblingFirstSession,
  splitLeaf,
  type LayoutNode,
  type SnapshotNode,
  type SplitNode,
} from "../src/store/layoutTree.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function approx(a: number, b: number) {
  return Math.abs(a - b) < 1e-9;
}

// splitLeaf：leaf 換成 split，原 leaf 為 a、新 session 為 b、ratio 0.5
{
  const l = leaf("s1");
  const t = splitLeaf(l, l.id, "row", "s2") as SplitNode;
  check("splitLeaf 產生 split 節點", t.type === "split" && t.dir === "row");
  check("splitLeaf ratio 為 0.5", t.ratio === 0.5);
  check(
    "splitLeaf 原 leaf 在 a、新 session 在 b",
    t.a.type === "leaf" && t.a.sessionId === "s1" &&
    t.b.type === "leaf" && t.b.sessionId === "s2",
  );
  check("splitLeaf 未命中時回傳原樹（引用相等）", splitLeaf(l, "nope", "row", "x") === l);
}

// removeLeafBySession：sibling 晉升、root leaf 移除回 null
{
  const l = leaf("s1");
  const t = splitLeaf(l, l.id, "row", "s2");
  const afterRemoveB = removeLeafBySession(t, "s2");
  check("移除 b → sibling a 晉升", afterRemoveB?.type === "leaf" && afterRemoveB.sessionId === "s1");
  const afterRemoveA = removeLeafBySession(t, "s1");
  check("移除 a → sibling b 晉升", afterRemoveA?.type === "leaf" && afterRemoveA.sessionId === "s2");
  check("移除 root leaf → null", removeLeafBySession(leaf("x"), "x") === null);
  check("移除不存在的 session → 原樹（引用相等）", removeLeafBySession(t, "nope") === t);
}

// 深層收合：三層樹移除中間 leaf
{
  const l1 = leaf("s1");
  let t: LayoutNode = splitLeaf(l1, l1.id, "row", "s2");
  const leafS2 = findLeafBySession(t, "s2")!;
  t = splitLeaf(t, leafS2.id, "column", "s3");
  check("三 leaf 樹 collectSessionIds", collectSessionIds(t).join(",") === "s1,s2,s3");
  const t2 = removeLeafBySession(t, "s2")!;
  check("移除深層 leaf 後剩兩個 session", collectSessionIds(t2).join(",") === "s1,s3");
  // s3 晉升到原本 s2/s3 那個 split 的位置
  const root2 = t2 as SplitNode;
  check("收合後 s3 晉升為 root.b", root2.b.type === "leaf" && root2.b.sessionId === "s3");
}

// setRatio + clamp
{
  const l = leaf("s1");
  const t = splitLeaf(l, l.id, "row", "s2") as SplitNode;
  const t2 = setRatio(t, t.id, 0.3) as SplitNode;
  check("setRatio 更新比例", approx(t2.ratio, 0.3));
  const t3 = setRatio(t, t.id, 1.5) as SplitNode;
  check("setRatio clamp 上限", t3.ratio === 0.95);
  const t4 = setRatio(t, t.id, -1) as SplitNode;
  check("setRatio clamp 下限", t4.ratio === 0.05);
  check("clampRatio NaN → 0.5", clampRatio(NaN) === 0.5);
  check("setRatio 未命中回原樹（引用相等）", setRatio(t, "nope", 0.3) === t);
}

// computeLayout：row 左右並排、column 上下疊、resizer 位置
{
  const l = leaf("s1");
  const t = setRatio(
    splitLeaf(l, l.id, "row", "s2"),
    (splitLeaf(l, l.id, "row", "s2") as SplitNode).id, // 不同樹的 id，不會命中
    0.3,
  );
  // 直接用 0.5 樹驗證
  const { leaves, resizers } = computeLayout(splitLeaf(l, l.id, "row", "s2"));
  const r1 = leaves.get("s1")!;
  const r2 = leaves.get("s2")!;
  check("row 分割：a 佔左半", approx(r1.left, 0) && approx(r1.width, 50) && approx(r1.height, 100));
  check("row 分割：b 佔右半", approx(r2.left, 50) && approx(r2.width, 50));
  check("row 分割：一條垂直 resizer 在 50%", resizers.length === 1 && approx(resizers[0].rect.left, 50) && resizers[0].dir === "row");
  void t;
}
{
  // 巢狀：root row(0.5) → b 再 column(0.5)
  const l1 = leaf("s1");
  let t: LayoutNode = splitLeaf(l1, l1.id, "row", "s2");
  const leafS2 = findLeafBySession(t, "s2")!;
  t = splitLeaf(t, leafS2.id, "column", "s3");
  const { leaves, resizers } = computeLayout(t);
  const r2 = leaves.get("s2")!;
  const r3 = leaves.get("s3")!;
  check("巢狀：s2 佔右上", approx(r2.left, 50) && approx(r2.top, 0) && approx(r2.height, 50));
  check("巢狀：s3 佔右下", approx(r3.left, 50) && approx(r3.top, 50) && approx(r3.height, 50));
  check("巢狀：兩條 resizer", resizers.length === 2);
  const h = resizers.find((r) => r.dir === "column")!;
  check("巢狀：水平 resizer 只跨右半", approx(h.rect.left, 50) && approx(h.rect.width, 50) && approx(h.rect.top, 50));
}

// siblingFirstSession：focus 移交
{
  const l1 = leaf("s1");
  let t: LayoutNode = splitLeaf(l1, l1.id, "row", "s2");
  const leafS2 = findLeafBySession(t, "s2")!;
  t = splitLeaf(t, leafS2.id, "column", "s3");
  check("sibling：直接子 leaf（a 側）", siblingFirstSession(t, "s1") === "s2");
  check("sibling：深層 leaf", siblingFirstSession(t, "s2") === "s3");
  check("sibling：深層 leaf 反向", siblingFirstSession(t, "s3") === "s2");
  check("sibling：不在樹中 → null", siblingFirstSession(t, "nope") === null);
  check("sibling：root leaf → null", siblingFirstSession(leaf("x"), "x") === null);
  check("sibling：null 樹 → null", siblingFirstSession(null, "x") === null);
}

// findTreeBySession：跨多棵群組樹找出 session 所屬的樹
{
  const l1 = leaf("s1");
  const g1 = splitLeaf(l1, l1.id, "row", "s2");
  const l3 = leaf("s3");
  const g2 = splitLeaf(l3, l3.id, "column", "s4");
  const trees = { g1, g2 };
  check("findTree 命中第一棵", findTreeBySession(trees, "s2") === "g1");
  check("findTree 命中第二棵", findTreeBySession(trees, "s4") === "g2");
  check("findTree 不在任何樹 → null", findTreeBySession(trees, "nope") === null);
  check("findTree 空 record → null", findTreeBySession({}, "s1") === null);
}

// leafCount：「群組恆有 ≥2 leaf」的判定式
{
  const l = leaf("s1");
  const t2 = splitLeaf(l, l.id, "row", "s2") as SplitNode;
  const t3 = splitLeaf(t2, (t2.b as { id: string }).id, "column", "s3");
  check("leafCount：null → 0", leafCount(null) === 0);
  check("leafCount：單一 leaf → 1", leafCount(l) === 1);
  check("leafCount：兩個 leaf → 2", leafCount(t2) === 2);
  check("leafCount：三個 leaf → 3", leafCount(t3) === 3);
}

// hydrateSnapshotNode：快照節點（無 node id）→ LayoutNode（id 全部重生）
{
  const snap: SnapshotNode = {
    type: "split",
    dir: "column",
    ratio: 0.3,
    a: { type: "leaf", sessionId: "s1" },
    b: {
      type: "split",
      dir: "row",
      ratio: 0.7,
      a: { type: "leaf", sessionId: "s2" },
      b: { type: "leaf", sessionId: "s3" },
    },
  };
  const t = hydrateSnapshotNode(snap) as SplitNode;
  check("hydrate 保留方向與比例", t.dir === "column" && approx(t.ratio, 0.3));
  check("hydrate 保留 session 順序", collectSessionIds(t).join(",") === "s1,s2,s3");
  check("hydrate leaf 數不變", leafCount(t) === 3);
  // node id 是還原時新生的，且每個節點各不相同 —— 唯一性因此是結構性的，
  // 不必靠快照裡的 id 沒撞到執行期的 id。
  const ids: string[] = [];
  const walk = (n: LayoutNode) => {
    ids.push(n.id);
    if (n.type === "split") {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(t);
  check("hydrate 每個節點都有 id", ids.length === 5 && ids.every((x) => x.length > 0));
  check("hydrate node id 互不重複", new Set(ids).size === ids.length);
  check(
    "hydrate 兩次得到不同的 node id",
    hydrateSnapshotNode(snap).id !== t.id,
  );
  check(
    "hydrate 把非法 ratio clamp 回合法範圍",
    (hydrateSnapshotNode({ ...snap, ratio: Number.NaN }) as SplitNode).ratio === 0.5 &&
      (hydrateSnapshotNode({ ...snap, ratio: 42 }) as SplitNode).ratio === MAX_RATIO,
  );
  check(
    "hydrate 單一 leaf",
    hydrateSnapshotNode({ type: "leaf", sessionId: "solo" }).type === "leaf",
  );
}

console.log(`\nlayout-tree: ${passed} checks passed`);
