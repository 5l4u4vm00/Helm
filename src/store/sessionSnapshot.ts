// 冷還原（cold restore）的協調層：把 session 清單 + 分割佈局寫成磁碟快照，
// 啟動時讀回來重建 pane。
//
// 分層原則：Helm 只還原「durable workspace state」（佈局、cwd、標題、agent
// 身分），不假裝復活行程 —— 還原出來的 pane 一律是新的 PTY 並標上 restored，
// agent 的對話交給它自己的 resume 指令（W-06）。這條界線是刻意的：看起來還原
// 了其實沒有，比明白說「這是上次的記錄」傷害大得多。
//
// 實作歸屬：W-04 feat/cold-restore。foundation 只固定簽名並在 App.tsx 的
// bootstrap 與關窗流程接好呼叫端。

/**
 * 讀快照並重建 sessions + layout。回傳是否真的還原了 —— false 代表沒有快照、
 * 讀取失敗，或使用者關掉了還原設定，呼叫端就走原本的 newSession()。
 */
export function restoreFromSnapshot(): Promise<boolean> {
  return Promise.resolve(false); // W-04
}

/** 開始監聽 store 變化並定期寫出（debounce；絕不在 setter 內同步寫）。 */
export function startSessionPersistence(): void {
  // W-04
}

/** 立刻寫出一次（關窗前、失焦時）。 */
export function flushSnapshot(): Promise<void> {
  return Promise.resolve(); // W-04
}
