// 接續（resume）的執行期狀態：哪個 session 剛送出 resume 指令、哪些 agent
// session id 已經被判定為失敗。
//
// 刻意只活在記憶體、不持久化：失敗記錄隨程序消失，所以一次誤判最壞只損失一次
// 便利，永遠不會讓 agentSessionIds 被修剪掉（見 agentIdentity.ts 的理由）。
//
// 實作歸屬：W-06 feat/agent-resume。foundation 只固定簽名並在 App.tsx /
// sessions.ts 接好呼叫端，讓那條支線不必碰已凍結的檔案。

/** 送出 resume 後多久內把 agent 印出的失敗訊息算作「這次 resume 的結果」。 */
export const RESUME_WATCH_MS = 20_000;

/** 剛把 resume 指令寫進這個 session 的 PTY。 */
export function markResumeAttempt(
  _sessionId: string,
  _agentSessionId: string | null,
  _now: number,
): void {
  // W-06
}

/** 這個 session 是否有一次還在觀察窗內的 resume。 */
export function pendingResume(
  _sessionId: string,
  _now: number,
): { agentSessionId: string | null } | undefined {
  return undefined; // W-06
}

export function markResumeFailed(_sessionId: string, _agentSessionId: string): void {
  // W-06
}

export function isResumeFailed(_sessionId: string, _agentSessionId: string): boolean {
  return false; // W-06
}

/**
 * 掃描文字裡有沒有「這次 resume 失敗了」的訊號（由 profile 的 resume.failure
 * pattern 決定）。命中時記錄失敗、發錯誤提醒，並回傳 true 讓 handleScan 早退
 * —— 失敗訊息不是一個待回應的提示，不該被當成 waiting。
 */
export function consumeResumeFailure(_sessionId: string, _text: string): boolean {
  return false; // W-06
}

export function clearResumeState(_sessionId: string): void {
  // W-06
}
