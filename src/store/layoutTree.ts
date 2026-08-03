// Split 版面樹的純運算（無 React/Zustand 依賴，可直接單元測試）。
// 樹是二元分割：leaf 對應一個 session，split 依方向把空間分成兩份。
// 不變量：一個 session 最多出現在一棵群組樹的一個 leaf；
// 同一群組的 session 屬於同一個 workspace。

export type SplitDir = "row" | "column"; // row = 左右並排, column = 上下疊

export interface LeafNode {
  type: "leaf";
  id: string;
  sessionId: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  dir: SplitDir;
  /** 第一個子節點（a）的佔比，clamp 到 MIN_RATIO–MAX_RATIO。 */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

/** 皆為相對 terminal-area 的百分比（0–100）。 */
export interface RectPct {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ResizerGeom {
  splitId: string;
  dir: SplitDir;
  /** 分隔線的位置（中心線），寬/高為 0，由 CSS 撐出 hit area。 */
  rect: RectPct;
  /** 所屬 split 的完整 rect（拖曳時把游標位置換算成 ratio 用）。 */
  splitRect: RectPct;
  /** 所屬 split 目前的 ratio（鍵盤微調的基準）。 */
  ratio: number;
}

export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

function nodeId(): string {
  return crypto.randomUUID();
}

export function leaf(sessionId: string): LeafNode {
  return { type: "leaf", id: nodeId(), sessionId };
}

/** 把指定 leaf 換成 SplitNode（原 leaf 為 a，新 session 為 b，各半）。 */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  dir: SplitDir,
  newSessionId: string,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.id !== leafId) return root;
    return { type: "split", id: nodeId(), dir, ratio: 0.5, a: root, b: leaf(newSessionId) };
  }
  const a = splitLeaf(root.a, leafId, dir, newSessionId);
  const b = a === root.a ? splitLeaf(root.b, leafId, dir, newSessionId) : root.b;
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

/** 移除 session 對應的 leaf，sibling 晉升到父的位置；root 就是該 leaf 時回 null。 */
export function removeLeafBySession(
  root: LayoutNode,
  sessionId: string,
): LayoutNode | null {
  if (root.type === "leaf") {
    return root.sessionId === sessionId ? null : root;
  }
  const a = removeLeafBySession(root.a, sessionId);
  if (a === null) return root.b;
  const b = removeLeafBySession(root.b, sessionId);
  if (b === null) return a;
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

/** 更新指定 split 的比例（clamp 後）。 */
export function setRatio(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (root.type === "leaf") return root;
  if (root.id === splitId) return { ...root, ratio: clampRatio(ratio) };
  const a = setRatio(root.a, splitId, ratio);
  const b = a === root.a ? setRatio(root.b, splitId, ratio) : root.b;
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

/** 一次遞迴同時算出每個 leaf 的 rect 與所有分隔線的幾何。 */
export function computeLayout(root: LayoutNode): {
  leaves: Map<string, RectPct>;
  resizers: ResizerGeom[];
} {
  const leaves = new Map<string, RectPct>();
  const resizers: ResizerGeom[] = [];
  const walk = (node: LayoutNode, rect: RectPct) => {
    if (node.type === "leaf") {
      leaves.set(node.sessionId, rect);
      return;
    }
    const r = clampRatio(node.ratio);
    if (node.dir === "row") {
      const wA = rect.width * r;
      walk(node.a, { ...rect, width: wA });
      walk(node.b, { ...rect, left: rect.left + wA, width: rect.width - wA });
      resizers.push({
        splitId: node.id,
        dir: "row",
        rect: { top: rect.top, left: rect.left + wA, width: 0, height: rect.height },
        splitRect: rect,
        ratio: r,
      });
    } else {
      const hA = rect.height * r;
      walk(node.a, { ...rect, height: hA });
      walk(node.b, { ...rect, top: rect.top + hA, height: rect.height - hA });
      resizers.push({
        splitId: node.id,
        dir: "column",
        rect: { top: rect.top + hA, left: rect.left, width: rect.width, height: 0 },
        splitRect: rect,
        ratio: r,
      });
    }
  };
  walk(root, { top: 0, left: 0, width: 100, height: 100 });
  return { leaves, resizers };
}

export function collectSessionIds(root: LayoutNode | null): string[] {
  if (!root) return [];
  if (root.type === "leaf") return [root.sessionId];
  return [...collectSessionIds(root.a), ...collectSessionIds(root.b)];
}

export function findLeafBySession(
  root: LayoutNode | null,
  sessionId: string,
): LeafNode | null {
  if (!root) return null;
  if (root.type === "leaf") return root.sessionId === sessionId ? root : null;
  return findLeafBySession(root.a, sessionId) ?? findLeafBySession(root.b, sessionId);
}

/** 該 session 的 leaf 被收合時，sibling 子樹中第一個 leaf 的 session（focus 移交用）。 */
export function siblingFirstSession(
  root: LayoutNode | null,
  sessionId: string,
): string | null {
  if (!root || root.type === "leaf" || !findLeafBySession(root, sessionId)) return null;
  if (root.a.type === "leaf" && root.a.sessionId === sessionId) {
    return collectSessionIds(root.b)[0] ?? null;
  }
  if (root.b.type === "leaf" && root.b.sessionId === sessionId) {
    return collectSessionIds(root.a)[0] ?? null;
  }
  const inA = findLeafBySession(root.a, sessionId) !== null;
  return siblingFirstSession(inA ? root.a : root.b, sessionId);
}

/** 找出包含該 session 的樹的 key（群組 id）；不在任何樹中回 null。 */
export function findTreeBySession(
  trees: Record<string, LayoutNode>,
  sessionId: string,
): string | null {
  for (const [key, root] of Object.entries(trees)) {
    if (findLeafBySession(root, sessionId)) return key;
  }
  return null;
}

/** 樹裡的 leaf 數量；「群組恆有 ≥2 個 leaf」這條不變量的判定式。 */
export function leafCount(root: LayoutNode | null): number {
  if (!root) return 0;
  return root.type === "leaf" ? 1 : leafCount(root.a) + leafCount(root.b);
}

/**
 * 序列化（寫進快照）後的節點形狀：與 LayoutNode 同構，但**沒有 node id**。
 * id 一律在還原時重新產生（見 hydrateSnapshotNode），所以「快照裡的 id 撞到
 * 執行期既有的 id」這整類損壞在結構上就不可表示 —— 上面那條唯一性不變量因此
 * 不必靠還原流程自律。
 */
export type SnapshotNode =
  | { type: "leaf"; sessionId: string }
  | { type: "split"; dir: SplitDir; ratio: number; a: SnapshotNode; b: SnapshotNode };

/** 快照節點 → LayoutNode：每個 node id 重生，ratio 順手 clamp 回合法範圍。 */
export function hydrateSnapshotNode(node: SnapshotNode): LayoutNode {
  if (node.type === "leaf") return leaf(node.sessionId);
  return {
    type: "split",
    id: nodeId(),
    dir: node.dir,
    ratio: clampRatio(node.ratio),
    a: hydrateSnapshotNode(node.a),
    b: hydrateSnapshotNode(node.b),
  };
}
