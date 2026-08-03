// 事件日記：把通知中心的項目 append 到磁碟，開機時讀回來。
// 目的是讓「我睡覺時 agent 做了什麼、哪一個中途死掉」跨重啟仍可回溯 ——
// 通知中心本身只在記憶體、上限 50 筆，重開就歸零。
//
// 實作歸屬：W-07 feat/event-journal。foundation 只固定簽名並在
// notifications.ts / App.tsx 接好呼叫端。
import type { AppNotification } from "./notificationCenter";

/** 追加一筆（fire-and-forget，失敗靜默：通知不該因為寫檔失敗而消失）。 */
export function appendJournalEntry(_n: AppNotification): void {
  // W-07
}

/** 開機時讀回歷史（已標成 resolved + read，數量受 NOTIFICATION_CAP 約束）。 */
export function loadJournalEntries(): Promise<AppNotification[]> {
  return Promise.resolve([]); // W-07
}
