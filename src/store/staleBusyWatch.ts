// 停滯偵測的定時掃描（不純：讀 store、發提醒）。純判定邏輯在 staleBusy.ts。
// 實作歸屬：W-02 feat/stale-busy-watchdog。

/** 啟動定時掃描；由 App.tsx 的 bootstrap 呼叫一次。 */
export function startStaleBusyWatchdog(): void {
  // W-02
}
