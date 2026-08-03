// 停滯偵測（stale-busy）：session 停在忙碌狀態但長時間沒有 PTY 輸出。
// 純函式 + module-level 時間戳（同 scanState.ts 的風格：now 由呼叫端注入、
// 惰性判斷不用 timer），node 測試可直接載入。
//
// 為什麼需要它：interrupted 只抓得到「PTY 真的死了」。行程還活著但實際上卡住
// （agent 等一個永遠不回的請求、網路斷線）時什麼事件都不會發生 —— 而「沉默」
// 跟「還在跑」在畫面上長得一模一樣，這正是 agent 工作流最難受的失敗模式。
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。
import type { AgentState } from "../agents/types";
// 「忙碌」的定義只有一份（見 isBusyState 的註解），這裡刻意不自己列狀態陣列。
import { isBusyState } from "./notificationRouter.ts";

/** 每個 session 最近一次看到 PTY 輸出的時間。 */
const lastOutputAt = new Map<string, number>();

/** 有輸出了。由 handleScan 在每次掃描時呼叫（極廉價：一次 Map.set）。 */
export function markPtyOutput(sessionId: string, now: number): void {
  lastOutputAt.set(sessionId, now);
}

/** 最近一次輸出時間；從未有過輸出時 undefined。 */
export function lastOutput(sessionId: string): number | undefined {
  return lastOutputAt.get(sessionId);
}

export function clearStaleBusy(sessionId: string): void {
  lastOutputAt.delete(sessionId);
}

/**
 * 忙碌但沉默多久才算停滯。5 分鐘是刻意保守的：一次慢工具（大型 build、長跑
 * 測試、等 rate limit 退避）安靜好幾分鐘完全正常，門檻壓太低只會製造狼來了。
 */
export const STALE_BUSY_THRESHOLD_MS = 5 * 60 * 1000;

/** detectStaleSessions 需要的最小 session 形狀（不綁 Session 全型別）。 */
interface StaleCandidate {
  id: string;
  agentState?: AgentState;
  stalled?: boolean;
}

/**
 * 挑出「停在忙碌但已經沉默過久」的 session id。純函式：時間由呼叫端注入，
 * 唯一的隱含輸入是本模組的輸出時間戳表。
 *
 * 四種刻意不誤報的情況：
 * - 從未有過輸出（lastOutput 為 undefined）—— 剛開的 pane 還沒吐任何東西，
 *   沒有「沉默」可言；拿建立時間當基準會讓每個新 pane 都在倒數。
 * - 已經 stalled —— 一次停滯只提醒一次（markStalled 也會再擋一層）。
 * - 非忙碌狀態（idle / done / error / 尚未偵測到 agent）—— 沒在工作的終端機
 *   本來就該是安靜的。
 * - 剛剛才有輸出 —— 未達門檻。
 */
export function detectStaleSessions(
  sessions: readonly StaleCandidate[],
  now: number,
  thresholdMs: number = STALE_BUSY_THRESHOLD_MS,
): string[] {
  const stale: string[] = [];
  for (const sess of sessions) {
    if (sess.stalled) continue;
    if (!isBusyState(sess.agentState)) continue;
    const seenAt = lastOutputAt.get(sess.id);
    if (seenAt === undefined) continue;
    if (now - seenAt >= thresholdMs) stale.push(sess.id);
  }
  return stale;
}
