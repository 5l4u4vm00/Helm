// 分割群組樹的狀態管理。每個群組一棵樹（key 為群組 id），樹只算幾何，
// Terminal pane 本體由 App.tsx 平鋪渲染（只渲染 active session 所在群組的樹）。
// 不變量：群組樹恆有 ≥2 個 leaf（收合到 1 個 leaf 時整組解散）。
import { create } from "zustand";
import {
  computeLayout,
  findLeafBySession,
  findTreeBySession,
  leaf,
  leafCount,
  removeLeafBySession,
  setRatio as setTreeRatio,
  splitLeaf,
  type LayoutNode,
  type SplitDir,
} from "./layoutTree";

/** pane 最小尺寸（px），拖曳 clamp 與分割前檢查共用。 */
export const MIN_PANE_W = 120;
export const MIN_PANE_H = 80;

/** 量 terminal-area 的實際 px 尺寸（分割前檢查用；量不到就不擋）。 */
function areaSize(): { width: number; height: number } | null {
  const el = document.querySelector(".terminal-area");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
}

/** 該 session 所在群組的樹；未分組回 null。 */
export function groupTreeOf(
  trees: Record<string, LayoutNode>,
  sessionId: string | null,
): LayoutNode | null {
  if (!sessionId) return null;
  const key = findTreeBySession(trees, sessionId);
  return key ? trees[key] : null;
}

interface LayoutState {
  /** 群組 id → 該群組的版面樹（session 至多屬於一個群組）。 */
  trees: Record<string, LayoutNode>;
  /** 分割後的兩半是否都還夠大（量不到 DOM 時放行）。 */
  canSplitPane: (sessionId: string, dir: SplitDir) => boolean;
  /** 把 newSessionId 分割進 sessionId 的 leaf；未分組時先新建群組。 */
  splitPane: (sessionId: string, dir: SplitDir, newSessionId: string) => void;
  /** session 關閉或搬離 workspace 時收合對應 leaf；群組剩單一 leaf 即解散。 */
  removeSession: (sessionId: string) => void;
  setRatio: (splitId: string, ratio: number) => void;
  /**
   * 冷還原：整批置換群組樹。傳進來的樹必須已經滿足不變量（node id 重生、
   * session 不重複、同 workspace）—— 那是 reconcileSnapshot 的責任，這裡只再
   * 擋一次「群組恆有 ≥2 leaf」，並重新產生群組 id。
   */
  restoreTrees: (groups: LayoutNode[]) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const commit = (groupId: string, root: LayoutNode) =>
    set((s) => ({ trees: { ...s.trees, [groupId]: root } }));
  const drop = (groupId: string) =>
    set((s) => {
      const { [groupId]: _dropped, ...rest } = s.trees;
      return { trees: rest };
    });

  return {
    trees: {},

    canSplitPane: (sessionId, dir) => {
      const size = areaSize();
      if (!size) return true;
      const root = groupTreeOf(get().trees, sessionId);
      if (!root) {
        // 未分組：窗格佔滿整個 terminal-area。
        return dir === "row"
          ? size.width >= MIN_PANE_W * 2
          : size.height >= MIN_PANE_H * 2;
      }
      const rect = computeLayout(root).leaves.get(sessionId);
      if (!rect) return true;
      // rect 是百分比 → 換回 px，分割後兩半各需容得下最小尺寸。
      return dir === "row"
        ? (rect.width / 100) * size.width >= MIN_PANE_W * 2
        : (rect.height / 100) * size.height >= MIN_PANE_H * 2;
    },

    splitPane: (sessionId, dir, newSessionId) => {
      const groupId = findTreeBySession(get().trees, sessionId);
      if (!groupId) {
        // 未分組 → 以該 session 為底新建群組再分割。
        const base = leaf(sessionId);
        commit(crypto.randomUUID(), splitLeaf(base, base.id, dir, newSessionId));
        return;
      }
      const root = get().trees[groupId];
      const target = findLeafBySession(root, sessionId)!;
      commit(groupId, splitLeaf(root, target.id, dir, newSessionId));
    },

    removeSession: (sessionId) => {
      // session id 全域唯一，至多命中一棵樹。
      const groupId = findTreeBySession(get().trees, sessionId);
      if (!groupId) return;
      const next = removeLeafBySession(get().trees[groupId], sessionId);
      if (!next || next.type === "leaf") {
        // 剩單一 leaf 即解散群組，倖存的 session 回到未分組全螢幕。
        drop(groupId);
        return;
      }
      commit(groupId, next);
    },

    // commit / drop 之外的第三個寫入點，且是唯一一個整批置換 trees 的：只在
    // 啟動還原時跑一次，之後所有變動仍走 commit / drop。
    restoreTrees: (groups) => {
      const trees: Record<string, LayoutNode> = {};
      for (const root of groups) {
        if (leafCount(root) < 2) continue;
        trees[crypto.randomUUID()] = root;
      }
      set({ trees });
    },

    setRatio: (splitId, ratio) => {
      // split node id 全域唯一（UUID），至多命中一棵樹。
      for (const [groupId, root] of Object.entries(get().trees)) {
        const next = setTreeRatio(root, splitId, ratio);
        if (next !== root) {
          commit(groupId, next);
          return;
        }
      }
    },
  };
});

export type { LayoutNode, SplitDir };
