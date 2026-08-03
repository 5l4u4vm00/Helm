// 停滯偵測（stale-busy）：session 停在忙碌狀態但長時間沒有 PTY 輸出。
// 純函式 + module-level 時間戳（同 scanState.ts 的風格：now 由呼叫端注入、
// 惰性判斷不用 timer），node 測試可直接載入。
//
// 為什麼需要它：interrupted 只抓得到「PTY 真的死了」。行程還活著但實際上卡住
// （agent 等一個永遠不回的請求、網路斷線）時什麼事件都不會發生 —— 而「沉默」
// 跟「還在跑」在畫面上長得一模一樣，這正是 agent 工作流最難受的失敗模式。
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。

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
