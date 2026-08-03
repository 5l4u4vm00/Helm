// 冷還原（cold restore）的協調層：把 session 清單 + 分割佈局寫成磁碟快照，
// 啟動時讀回來重建 pane。
//
// 分層原則：Helm 只還原「durable workspace state」（佈局、cwd、標題、agent
// 身分），不假裝復活行程 —— 還原出來的 pane 一律是新的 PTY 並標上 restored，
// agent 的對話交給它自己的 resume 指令（W-06）。這條界線是刻意的：看起來還原
// 了其實沒有，比明白說「這是上次的記錄」傷害大得多。
//
// 純粹的部分（格式、驗證、不變量修復）全在 sessionSnapshotSchema.ts，本檔只
// 負責 I/O、store 讀寫與寫檔時機。
import { useSessionStore, type Session } from "./sessions";
import { useLayoutStore } from "./layout";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspaces";
import { useFolderStatusStore } from "./folderStatus";
import {
  normalizeSnapshot,
  projectSnapshot,
  reconcileSnapshot,
  sessionsPersistEqual,
  type SnapshotSession,
} from "./sessionSnapshotSchema";
import { resumeCommandForRestore } from "../commands/actions";
import { readAppFile, writeAppFile, SNAPSHOT_FILE } from "../ipc/appStore";
import { getVersion } from "@tauri-apps/api/app";

/** trailing debounce：使用者停手 800ms 才寫。 */
const DEBOUNCE_MS = 800;
/** 硬上限：持續變動（例如一直改標題）時最多 5s 一定寫一次。 */
const HARD_CAP_MS = 5_000;

/**
 * 本次啟動是否允許寫檔。讀 manifest 回 { ok:false } 就整場關閉 —— 一次暫時性
 * 的讀取失敗若被當成「沒有快照」，接著就會用一份空快照蓋掉好的檔案。
 * 純瀏覽器 `npm run dev` 每個 invoke 都 reject，所以那裡的行為與沒有持久化的
 * 舊版完全相同（開一個新 session、不寫檔）。
 */
let persistEnabled = true;
/** startSessionPersistence 是否跑過。flushSnapshot 靠它擋掉 bootstrap 完成前的
 *  blur —— 那時 store 還是空的，寫出去等於把好檔案清空。 */
let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** 這一輪 dirty 的起點（0 = 不 dirty），用來套 HARD_CAP_MS。 */
let dirtySince = 0;
/** 診斷用：寫檔時記下 app 版本。取不到就不寫這個欄位。 */
let appVersion: string | undefined;
/**
 * sessionId → 上次的啟動指令。還原時刻意不寫回 Session.launchCommand（見
 * schema 的 lastLaunchCommand），所以得在這裡接住，否則重開兩次就遺失。
 */
let carriedLaunchCommands: Record<string, string> = {};

/** 立刻序列化並寫檔。內部用（不看 started，還原後的自癒寫入要能繞過它）。 */
async function writeSnapshotNow(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  dirtySince = 0;
  if (!persistEnabled) return;
  const { sessions, activeId } = useSessionStore.getState();
  const snap = projectSnapshot({
    sessions,
    trees: useLayoutStore.getState().trees,
    activeId,
    savedAt: Date.now(),
    appVersion,
    carriedLaunchCommands,
  });
  await writeAppFile(SNAPSHOT_FILE, JSON.stringify(snap));
}

/**
 * 排一次寫檔。絕不在 store 的 setter 內同步序列化/寫檔 —— 那些 setter 跑在 PTY
 * 輸出頻率上；這裡只碰兩個 timer 變數。
 */
function scheduleWrite(): void {
  if (!persistEnabled) return;
  const now = Date.now();
  if (dirtySince === 0) dirtySince = now;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, dirtySince + HARD_CAP_MS - now));
  debounceTimer = setTimeout(() => {
    void writeSnapshotNow();
  }, wait);
}

/** 快照裡的一筆 → 執行期 Session。差異就是那條分層原則的全部內容。 */
function toSession(s: SnapshotSession): Session {
  return {
    id: s.id, // 絕不重新產生：它同時是 PTY key、HELM_SESSION_ID 與 hook 路由 key
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
    workspaceId: s.workspaceId,
    cwd: s.cwd,
    titleLocked: s.titleLocked,
    agentId: s.agentId,
    agentLabel: s.agentLabel,
    agentSessionIds: s.agentSessionIds,
    transcriptPath: s.transcriptPath,
    // launchCommand 預設留空：把上次的啟動指令寫回去，Terminal.tsx 的主 effect
    // 就會把它送進新開的 PTY，無聲重跑一次 agent。原值留在 carriedLaunchCommands。
    //
    // 唯一的例外是使用者自己開了「啟動時自動接續」：那時放的是**接續**指令
    // （resumeCommandForRestore 會擋掉 relaunch，只回真的接得回對話的那種），
    // 而且必須在 pane 掛載前就放好 —— 那條路徑順便免費繼承 Terminal.tsx 的
    // `if (launchCommand && launched)` 護欄：cwd 落回 $HOME 時不送指令。
    // 這對 resume 不是錦上添花而是正確性本身，因為 claude --resume 是以目錄為
    // scope 的，在錯的目錄接續等於指向錯的 repo。
    launchCommand:
      resumeCommandForRestore({
        agentId: s.agentId,
        agentSessionIds: s.agentSessionIds,
        launchCommand: s.lastLaunchCommand,
      }) ?? undefined,
    restored: true,
  };
}

/**
 * 讀快照並重建 sessions + layout。回傳是否真的還原了 —— false 代表沒有快照、
 * 讀取失敗，或使用者關掉了還原設定，呼叫端就走原本的 newSession()。
 */
export async function restoreFromSnapshot(): Promise<boolean> {
  // 先讀，再看設定：這一次讀取同時也是「狀態檔到底能不能用」的探測，關掉還原
  // 的人仍然會持續寫檔，之後把設定打開就能立刻用上最新狀態。
  const read = await readAppFile(SNAPSHOT_FILE);
  if (!read.ok) {
    persistEnabled = false;
    return false;
  }
  if (read.text === null) return false;
  if (!useSettingsStore.getState().restoreSessions) return false;

  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return false;
  }
  const snap = normalizeSnapshot(raw);
  if (!snap) return false;

  const workspaceIds = useWorkspaceStore.getState().workspaces.map((w) => w.id);
  const { sessions, activeId, groups, repairs } = reconcileSnapshot(snap, workspaceIds);
  if (sessions.length === 0) return false;
  if (repairs.length > 0) {
    console.warn(`[helm] ${SNAPSHOT_FILE} repaired on restore:`, repairs);
  }

  carriedLaunchCommands = {};
  const restored = sessions.map((s) => {
    if (s.lastLaunchCommand) carriedLaunchCommands[s.id] = s.lastLaunchCommand;
    return toSession(s);
  });

  // 先擺好版面再放 session：反過來會有一個 frame 是「pane 都在但幾何還沒到」。
  useLayoutStore.getState().restoreTrees(groups);
  useSessionStore.getState().restoreSessions({ sessions: restored, activeId });

  // 上次的資料夾可能已經不在（磁碟未掛載、專案搬走）。fire-and-forget，只驅動
  // 側欄把路徑劃掉；Terminal.tsx 自己會落回 $HOME。
  const probed = new Set<string>();
  const folderStatus = useFolderStatusStore.getState();
  for (const s of restored) {
    if (!s.cwd || probed.has(s.cwd)) continue;
    probed.add(s.cwd);
    folderStatus.probe(s.cwd);
  }

  // 立刻把「修復後」的狀態寫回去，損壞的檔案因此會自癒，而不是每次啟動都重跑
  // 同一批修復。
  void writeSnapshotNow();
  return true;
}

/** 開始監聽 store 變化並定期寫出（debounce；絕不在 setter 內同步寫）。 */
export function startSessionPersistence(): void {
  if (started) return;
  started = true;
  void getVersion()
    .then((v) => {
      appVersion = v;
    })
    .catch(() => {});

  useSessionStore.subscribe((s, prev) => {
    // 只比持久化欄位：cost/token/changedFiles/agentState 每秒都在動，算進去就
    // 等於把寫檔掛在 PTY 輸出頻率上。
    if (s.activeId === prev.activeId && sessionsPersistEqual(s.sessions, prev.sessions)) return;
    scheduleWrite();
  });
  useLayoutStore.subscribe((s, prev) => {
    // trees 只在 commit / drop / restoreTrees 被整個換掉，參照比較就是精準判定。
    if (s.trees === prev.trees) return;
    scheduleWrite();
  });

  // 冷啟動出來的那個新 session 也要進檔案，否則「開了就關」的一輪什麼都沒存。
  scheduleWrite();
}

/** 立刻寫出一次（關窗前、失焦時）。 */
export async function flushSnapshot(): Promise<void> {
  if (!started) return;
  await writeSnapshotNow();
}
