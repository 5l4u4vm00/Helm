// 停滯偵測的定時掃描（不純：讀 store、發提醒）。純判定邏輯在 staleBusy.ts。
// 實作歸屬：W-02 feat/stale-busy-watchdog。
//
// 為什麼要 timer：停滯的定義是「什麼事都沒發生」，沒有任何事件可以掛。所以
// 這是全 app 唯一一個必須主動輪詢的訊號源 —— 其餘狀態都由 PTY 輸出 / hook /
// 標題變化推動。tick 遠短於門檻（30s vs 5min），提醒延遲最多一個 tick，而每
// 次 tick 的成本只是掃一遍 session 陣列做整數相減。
import { useSessionStore } from "./sessions";
import { detectStaleSessions } from "./staleBusy";

/** 輪詢間隔。門檻的一小部分即可：只影響「發現得多晚」，不影響門檻本身。 */
const TICK_MS = 30 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;

/** 啟動定時掃描；由 App.tsx 的 bootstrap 呼叫一次。重複呼叫是 no-op。 */
export function startStaleBusyWatchdog(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    // 每 tick 重讀 store：sessions 是不可變陣列，抓舊快照會漏掉新開的 pane。
    const { sessions, markStalled } = useSessionStore.getState();
    for (const id of detectStaleSessions(sessions, Date.now())) {
      markStalled(id);
    }
  }, TICK_MS);
}

/** 停止掃描（測試/熱重載用；正常執行期不需要）。 */
export function stopStaleBusyWatchdog(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}
