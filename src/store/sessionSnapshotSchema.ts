// session 清單 + 分割佈局快照的格式定義與純函式（投影 / 驗證 / 不變量修復）。
//
// 為什麼獨立成一支檔案：這裡每一個決定都直接等於「重開機之後畫面對不對」，
// 必須能在 node 下直接測（無 React / Zustand / Tauri），所以輸入一律用結構
// 型別描述，不 import store —— 同 sessionTitle.ts 的作法。
// 唯一的相依是同樣純粹的 layoutTree / workspaceGroups：不變量修復本來就該用
// layoutTree 既有的 removeLeafBySession / collectSessionIds，另寫一份等於多一
// 份會走鐘的規則。
//
// 快照裡「有什麼」比「沒什麼」好懂，所以把界線寫在這裡：
//   存 —— 身分（id / title / createdAt）、歸屬（workspaceId / cwd）、
//         agent 身分（agentId / agentLabel / agentSessionIds / transcriptPath）。
//   丟 —— cost / tokensIn / tokensOut / contextLeftPercent / changedFiles /
//         agentState / pendingApproval / pendingPrompt。
// 丟掉的那排是「本次執行」的觀測值（sessions.ts 裡同一條分界註解）。結果是
// 結構性的保證，不是靠人自律：重啟後 ApprovalPanel 一定是空的、狀態燈一定
// 誠實 —— 一個假的待審批提示在這個格式裡根本無法表示。
import {
  collectSessionIds,
  hydrateSnapshotNode,
  leafCount,
  removeLeafBySession,
  type LayoutNode,
  type SnapshotNode,
  // .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入這條相依鏈。
} from "./layoutTree.ts";
import { DEFAULT_WORKSPACE_ID } from "./workspaceGroups.ts";

/**
 * 快照格式版本。認不得（或缺）就整份丟棄冷啟動，永不 migrate —— 猜錯舊格式
 * 的代價是重建出一組騙人的 pane，而冷啟動的代價只是少一次便利。
 * 新增「選填」欄位不必 bump：舊檔缺欄位走既有的 undefined 路徑即可。
 */
export const SNAPSHOT_VERSION = 1;

/** 樹的深度上限：手改壞（或惡意）的檔案不該讓遞迴驗證炸掉整個啟動流程。 */
const MAX_NODE_DEPTH = 64;

/** 對映 sessions.ts 的 SessionStatus。刻意不 import，讓本模組零 store 相依；
 *  真的走鐘時 sessionSnapshot.ts 的組裝處會被 tsc 擋下來。 */
export type SnapshotSessionStatus = "idle" | "busy" | "exited";

/** 一個 pane 的 durable 狀態。 */
export interface SnapshotSession {
  id: string;
  title: string;
  status: SnapshotSessionStatus;
  createdAt: number;
  workspaceId: string;
  cwd?: string;
  /**
   * Workspace recipe 在建立當下快照到這個 session 的環境變數。屬於「歸屬」而
   * 非「本次執行的觀測值」，和 cwd 同一側：還原出來的 pane 會開新 PTY，那個
   * PTY 需要和原本一樣的環境，否則 agent 會在不同環境下重跑。
   * 與 lastLaunchCommand 的差別正是本檔案的分界：env 是被動的環境，寫回去不會
   * 自己執行任何東西；command 會。
   */
  env?: Record<string, string>;
  titleLocked?: boolean;
  agentId: string | null;
  agentLabel?: string;
  /**
   * 上次這個 pane 跑的啟動指令。刻意不叫 launchCommand，也刻意不在還原時寫回
   * Session.launchCommand —— Terminal.tsx 會把它送進新開的 PTY，等於無聲重跑
   * 一次 agent。存著是為了讓未來的 PTY daemon 知道這個 pane 原本在跑什麼。
   */
  lastLaunchCommand?: string;
  agentSessionIds?: string[];
  transcriptPath?: string;
}

/** sessions.json 的 root。 */
export interface SessionSnapshot {
  version: number;
  savedAt: number;
  appVersion?: string;
  activeId: string | null;
  sessions: SnapshotSession[];
  /** 分割群組，陣列且不含 node id / group id（見 SnapshotNode）。 */
  groups: SnapshotNode[];
}

/** projectSnapshot 讀得到的欄位（結構型別，store 的 Session 可直接餵進來）。 */
export interface ProjectableSession {
  id: string;
  title: string;
  status: SnapshotSessionStatus;
  createdAt: number;
  workspaceId: string;
  cwd?: string;
  env?: Record<string, string>;
  titleLocked?: boolean;
  agentId: string | null;
  agentLabel?: string;
  launchCommand?: string;
  agentSessionIds?: string[];
  transcriptPath?: string;
  /** 這個 pane 是還原出來的 —— 決定 lastLaunchCommand 取 carried 還是現值。 */
  restored?: boolean;
}

export interface ProjectSnapshotInput {
  sessions: readonly ProjectableSession[];
  /** layout store 的 trees；node id 會在投影時剝掉。 */
  trees: Readonly<Record<string, LayoutNode>>;
  activeId: string | null;
  savedAt: number;
  appVersion?: string;
  /**
   * sessionId → 上一份快照的 lastLaunchCommand。還原出來的 pane 其
   * launchCommand 刻意留空（見 SnapshotSession.lastLaunchCommand），所以得從
   * 這裡接下去，否則重開兩次這筆資訊就沒了。
   */
  carriedLaunchCommands?: Readonly<Record<string, string>>;
}

/** 把 LayoutNode 剝成不含 node id 的 SnapshotNode（逐欄重建，不夾帶多餘欄位）。 */
function toSnapshotNode(node: LayoutNode): SnapshotNode {
  if (node.type === "leaf") return { type: "leaf", sessionId: node.sessionId };
  return {
    type: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: toSnapshotNode(node.a),
    b: toSnapshotNode(node.b),
  };
}

/**
 * 執行期狀態 → 快照。逐欄挑選（而非 spread）就是那條「丟棄非持久化欄位」的
 * 界線：新增執行期欄位時預設不會被帶進檔案裡。
 */
export function projectSnapshot(input: ProjectSnapshotInput): SessionSnapshot {
  const sessions = input.sessions.map((s) => {
    const out: SnapshotSession = {
      id: s.id,
      title: s.title,
      status: s.status,
      createdAt: s.createdAt,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
    };
    if (s.cwd !== undefined) out.cwd = s.cwd;
    if (s.env && Object.keys(s.env).length > 0) out.env = { ...s.env };
    if (s.titleLocked) out.titleLocked = true;
    if (s.agentLabel !== undefined) out.agentLabel = s.agentLabel;
    // 還原出來的 session：carried（上次記下的原始啟動指令）優先。理由是它的
    // launchCommand 可能是還原時合成的**接續**指令（自動接續設定開啟時），若讓
    // 它勝出，每次重啟都會把原始指令再往外推一層（claude → claude --resume X →
    // …），最後連 relaunch 都變成用過期 id 去接續。使用者無法在既有 pane 上改
    // launchCommand（啟動 agent 一律開新 session），所以對還原的 session 來說
    // carried 就是唯一的真相。
    const carried = input.carriedLaunchCommands?.[s.id];
    const launch = s.restored ? (carried ?? s.launchCommand) : (s.launchCommand ?? carried);
    if (launch !== undefined) out.lastLaunchCommand = launch;
    if (s.agentSessionIds && s.agentSessionIds.length > 0) {
      out.agentSessionIds = [...s.agentSessionIds];
    }
    if (s.transcriptPath !== undefined) out.transcriptPath = s.transcriptPath;
    // restored 刻意不寫進快照：那會讓資料格式等於宣告「還原＝行程已死」，
    // 未來由 daemon 接回活著的 PTY 時就得改格式。
    return out;
  });
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: input.savedAt,
    activeId: input.activeId,
    sessions,
    groups: Object.values(input.trees).map(toSnapshotNode),
  };
  if (input.appVersion !== undefined) snap.appVersion = input.appVersion;
  return snap;
}

function isStatus(v: unknown): v is SnapshotSessionStatus {
  return v === "idle" || v === "busy" || v === "exited";
}

/** 逐欄 typeof 檢查；任一欄不對就丟掉「這一筆」而非整批（同 normalizeWorkspaces）。 */
/** 快照裡的 env：只收字串→字串的項目，全空則回 undefined（不留 `{}`）。 */
function normalizeSnapshotEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSession(item: unknown): SnapshotSession | null {
  if (!item || typeof item !== "object") return null;
  const {
    id,
    title,
    status,
    createdAt,
    workspaceId,
    cwd,
    env,
    titleLocked,
    agentId,
    agentLabel,
    lastLaunchCommand,
    agentSessionIds,
    transcriptPath,
  } = item as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof title !== "string") return null;
  if (!isStatus(status)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof workspaceId !== "string" || workspaceId === "") return null;
  if (agentId !== null && typeof agentId !== "string") return null;
  if (cwd !== undefined && typeof cwd !== "string") return null;
  if (titleLocked !== undefined && typeof titleLocked !== "boolean") return null;
  if (agentLabel !== undefined && typeof agentLabel !== "string") return null;
  if (lastLaunchCommand !== undefined && typeof lastLaunchCommand !== "string") return null;
  if (transcriptPath !== undefined && typeof transcriptPath !== "string") return null;
  if (
    agentSessionIds !== undefined &&
    (!Array.isArray(agentSessionIds) || agentSessionIds.some((x) => typeof x !== "string"))
  ) {
    return null;
  }
  const out: SnapshotSession = { id, title, status, createdAt, workspaceId, agentId };
  if (cwd !== undefined) out.cwd = cwd;
  // env 逐項挑選而非整個 session 判死：壞掉的環境變數頂多讓 PTY 少一個變數，
  // 為此丟掉整個 pane（連同它的 cwd、標題、agent 身分）是不成比例的懲罰。
  // 保留 key 不在這裡擋 —— pty.rs 是最後一道，且它才知道平台大小寫規則。
  const cleanEnv = normalizeSnapshotEnv(env);
  if (cleanEnv) out.env = cleanEnv;
  if (titleLocked !== undefined) out.titleLocked = titleLocked;
  if (agentLabel !== undefined) out.agentLabel = agentLabel;
  if (lastLaunchCommand !== undefined) out.lastLaunchCommand = lastLaunchCommand;
  if (agentSessionIds !== undefined) out.agentSessionIds = [...(agentSessionIds as string[])];
  if (transcriptPath !== undefined) out.transcriptPath = transcriptPath;
  return out;
}

/** 節點形狀驗證（不變量 #2 的執行處）：壞掉回 null，呼叫端整組丟掉。 */
function normalizeNode(raw: unknown, depth: number): SnapshotNode | null {
  if (depth > MAX_NODE_DEPTH) return null;
  if (!raw || typeof raw !== "object") return null;
  const { type, sessionId, dir, ratio, a, b } = raw as Record<string, unknown>;
  if (type === "leaf") {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    return { type: "leaf", sessionId };
  }
  if (type !== "split") return null;
  if (dir !== "row" && dir !== "column") return null;
  // ratio 只要是數字就收：非有限值由 hydrateSnapshotNode 的 clampRatio 收斂成
  // 0.5，為一個比例丟掉整個群組不划算。
  if (typeof ratio !== "number") return null;
  const na = normalizeNode(a, depth + 1);
  const nb = normalizeNode(b, depth + 1);
  if (!na || !nb) return null;
  return { type: "split", dir, ratio, a: na, b: nb };
}

/**
 * 磁碟上的 JSON → 型別化快照。認不得的 version（含缺漏）→ null，呼叫端冷啟動。
 * 其餘一律「壞掉丟該筆」：壞的 session 丟該筆、形狀壞的群組丟整組。
 */
export function normalizeSnapshot(raw: unknown): SessionSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { version, savedAt, appVersion, activeId, sessions, groups } = raw as Record<
    string,
    unknown
  >;
  if (version !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(sessions)) return null;

  const outSessions: SnapshotSession[] = [];
  const seen = new Set<string>();
  for (const item of sessions) {
    const s = normalizeSession(item);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    outSessions.push(s);
  }

  const outGroups: SnapshotNode[] = [];
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const node = normalizeNode(g, 0);
      if (node) outGroups.push(node);
    }
  }

  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: typeof savedAt === "number" && Number.isFinite(savedAt) ? savedAt : 0,
    activeId: typeof activeId === "string" && activeId !== "" ? activeId : null,
    sessions: outSessions,
    groups: outGroups,
  };
  if (typeof appVersion === "string") snap.appVersion = appVersion;
  return snap;
}

export interface ReconciledSnapshot {
  sessions: SnapshotSession[];
  activeId: string | null;
  /** 已 hydrate 成帶新 node id 的樹；群組 id 由 layout store 重新產生。 */
  groups: LayoutNode[];
  /** 開發者可讀的修復記錄（只進 console，不進 UI，故不需 i18n）。 */
  repairs: string[];
}

/**
 * 把快照收斂回滿足所有執行期不變量的狀態。原則：**修群組、丟 leaf、絕不丟
 * session** —— 一個 pane 少了 split 位置還能用，pane 本身消失就是資料遺失。
 *
 * 順序（每一步都在修上一步造成的後果，故不可交換）：
 *   1. workspace 歸屬與 status（本函式）／欄位驗證（normalizeSnapshot）
 *   2. 節點形狀壞 → 丟整組（normalizeSnapshot；其 session 退回獨立全螢幕）
 *   3. leaf 指向不存在的 session → 移除該 leaf
 *   4. sessionId 重複（跨或同群組）→ 保留第一次出現
 *   5. 混到別的 workspace → 以第一個存活 leaf 的 workspace 為準
 *   6. 收合後 <2 leaf → 解散群組
 *   7. activeId 懸空 → 改指第一個 session
 */
export function reconcileSnapshot(
  snap: SessionSnapshot,
  knownWorkspaceIds: readonly string[],
): ReconciledSnapshot {
  const repairs: string[] = [];
  const known = new Set(knownWorkspaceIds);

  // (1) session 本身
  const sessions: SnapshotSession[] = [];
  const seen = new Set<string>();
  for (const s of snap.sessions) {
    if (seen.has(s.id)) {
      repairs.push(`session ${s.id}: duplicate entry dropped`);
      continue;
    }
    seen.add(s.id);
    const next: SnapshotSession = { ...s };
    if (!known.has(next.workspaceId)) {
      repairs.push(
        `session ${s.id}: workspace ${s.workspaceId} is gone -> ${DEFAULT_WORKSPACE_ID}`,
      );
      next.workspaceId = DEFAULT_WORKSPACE_ID;
    }
    // PTY 是新開的，所以上次記下的 busy/exited 是謊話 —— 不記進 repairs：
    // 這是每次還原的常態，不是損壞。
    next.status = "idle";
    sessions.push(next);
  }

  const workspaceOf = new Map(sessions.map((s) => [s.id, s.workspaceId]));
  /** 已被前面的群組收走的 session（findTreeBySession 的「第一個命中」語意）。 */
  const claimed = new Set<string>();
  const groups: LayoutNode[] = [];

  for (const rawNode of snap.groups) {
    let node: LayoutNode | null = hydrateSnapshotNode(rawNode);

    // (3)(4) 掃過原始 leaf 順序，每個「不該存在的出現位置」移掉一個 leaf。
    // 同一個 sessionId 在同群組出現兩次時，removeLeafBySession 收掉的是 DFS
    // 上較早的那個；兩片 leaf 完全等價，倖存的是哪一片沒有意義，重點是「一個
    // session 只剩一片 leaf」。
    const inThisGroup = new Set<string>();
    for (const id of collectSessionIds(node)) {
      if (!workspaceOf.has(id)) {
        repairs.push(`leaf dropped: session ${id} no longer exists`);
      } else if (claimed.has(id)) {
        repairs.push(`leaf dropped: session ${id} already belongs to an earlier group`);
      } else if (inThisGroup.has(id)) {
        repairs.push(`leaf dropped: session ${id} appears twice in one group`);
      } else {
        inThisGroup.add(id);
        continue;
      }
      node = node && removeLeafBySession(node, id);
    }

    // (5) 群組只含同 workspace 的 session（sessions.ts 的 reorderSession
    // 靠踢出群組維持的那條不變量）。
    const survivors = collectSessionIds(node);
    const groupWs = survivors.length > 0 ? workspaceOf.get(survivors[0]) : undefined;
    if (groupWs !== undefined) {
      for (const id of survivors) {
        if (workspaceOf.get(id) === groupWs) continue;
        repairs.push(`leaf dropped: session ${id} is not in the group's workspace ${groupWs}`);
        node = node && removeLeafBySession(node, id);
      }
    }

    // (6) 與 layout.ts 的 removeSession 逐字一致：剩單一 leaf 即解散群組，
    // 倖存的 session 回到未分組全螢幕。
    if (node === null || leafCount(node) < 2) {
      repairs.push("group dissolved: fewer than 2 panes left");
      continue;
    }
    for (const id of collectSessionIds(node)) claimed.add(id);
    groups.push(node);
  }

  // (7) activeId。這不是美化問題：App.tsx 只給「無群組的 active session」合成
  // 全螢幕 rect，activeId 懸空會讓畫面上所有 pane 都被判定為不在版面中而隱藏。
  let activeId = snap.activeId;
  if (activeId !== null && !workspaceOf.has(activeId)) {
    repairs.push(`activeId ${activeId} is gone`);
    activeId = null;
  }
  if (activeId === null) activeId = sessions.length > 0 ? sessions[0].id : null;

  return { sessions, activeId, groups, repairs };
}

function sameStringArray(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** env 的等值比較。session 的 env 是建立時快照、之後不變，所以這裡實務上恆真；
 *  仍然要比，因為它會寫進快照，漏比就等於「改了卻不存檔」。 */
function sameEnv(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (a === b) return true;
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => b?.[k] === a?.[k]);
}

/**
 * 兩個 session 的「會寫進快照」欄位是否等值。刻意不比 cost / tokens /
 * changedFiles / agentState / pendingApproval —— 那些跑在 PTY 輸出頻率上，
 * 算進去等於每秒排一次寫檔。
 */
export function snapshotFieldsEqual(a: ProjectableSession, b: ProjectableSession): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.status === b.status &&
    a.createdAt === b.createdAt &&
    a.workspaceId === b.workspaceId &&
    a.cwd === b.cwd &&
    sameEnv(a.env, b.env) &&
    Boolean(a.titleLocked) === Boolean(b.titleLocked) &&
    a.agentId === b.agentId &&
    a.agentLabel === b.agentLabel &&
    a.launchCommand === b.launchCommand &&
    a.transcriptPath === b.transcriptPath &&
    sameStringArray(a.agentSessionIds, b.agentSessionIds)
  );
}

/**
 * 整份 session 清單的持久化欄位是否等值。先比參照才逐欄比：store 的每個 setter
 * 只 spread 目標那一筆，其餘元素參照相等，所以一次 store tick 通常只是 N 次
 * 參照比較 —— 便宜到可以掛在每次 set() 上。
 */
export function sessionsPersistEqual(
  a: readonly ProjectableSession[],
  b: readonly ProjectableSession[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (!snapshotFieldsEqual(a[i], b[i])) return false;
  }
  return true;
}
