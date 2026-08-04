// 接續（resume）的執行期狀態：哪個 session 剛送出 resume 指令、哪些 agent
// session id 已經被判定為失敗。
//
// 刻意只活在記憶體、不持久化：失敗記錄隨程序消失，所以一次誤判最壞只損失一次
// 便利，永遠不會讓 agentSessionIds 被修剪掉（見 agentIdentity.ts 的理由）。
//
// 也刻意不自動重試下一個 id：輪替過的 id 屬於同一條對話鏈的不同段落，替換著
// 重試很可能靜默接到別段對話 —— 那比「按鈕沒反應」難察覺得多。失敗就標記、
// 通知使用者，下一次按鈕自然會落到下一個候選（或降級成 --continue）。
//
// 本模組不純（要讀 store、要發通知）；可測的判定邏輯放在 agents/resume.ts。
import { getProfile } from "../agents/registry";
import { matchResumeFailure } from "../agents/resume";
import { routeAlert, type AlertScope } from "./alertRoute";
// sessions.ts 只做 type-only import（會被編譯抹掉），所以這裡與它沒有執行期的
// 相互依賴 —— session 物件與 gating 用的 scope 都由呼叫端傳進來。
import type { Session } from "./sessions";

/** 送出 resume 後多久內把 agent 印出的失敗訊息算作「這次 resume 的結果」。 */
export const RESUME_WATCH_MS = 20_000;

/** 一次 resume 嘗試的觀察窗紀錄。 */
interface ResumeAttempt {
  /** byId 路徑鎖定的 agent session id；--continue / relaunch 為 null。 */
  agentSessionId: string | null;
  at: number;
}

const attempts = new Map<string, ResumeAttempt>();
/** sessionId → 已被判定失敗的 agent session id（只增不減，隨程序消失）。 */
const failedIds = new Map<string, Set<string>>();

/** 剛把 resume 指令寫進這個 session 的 PTY。 */
export function markResumeAttempt(
  sessionId: string,
  agentSessionId: string | null,
  now: number,
): void {
  attempts.set(sessionId, { agentSessionId, at: now });
}

/** 這個 session 是否有一次還在觀察窗內的 resume。 */
export function pendingResume(
  sessionId: string,
  now: number,
): { agentSessionId: string | null } | undefined {
  const attempt = attempts.get(sessionId);
  if (!attempt) return undefined;
  if (now - attempt.at > RESUME_WATCH_MS) {
    attempts.delete(sessionId);
    return undefined;
  }
  return attempt;
}

export function markResumeFailed(sessionId: string, agentSessionId: string): void {
  let set = failedIds.get(sessionId);
  if (!set) {
    set = new Set();
    failedIds.set(sessionId, set);
  }
  set.add(agentSessionId);
}

export function isResumeFailed(sessionId: string, agentSessionId: string): boolean {
  return failedIds.get(sessionId)?.has(agentSessionId) === true;
}

/**
 * 掃描文字裡有沒有「這次 resume 失敗了」的訊號（由 profile 的 resume.failure
 * pattern 決定）。命中時記錄失敗、發錯誤提醒，並回傳 true 讓 handleScan 早退
 * —— 失敗訊息不是一個待回應的提示，不該被當成 waiting。
 */
export function consumeResumeFailure(sess: Session, text: string, scope: AlertScope): boolean {
  const attempt = pendingResume(sess.id, Date.now());
  if (!attempt) return false;
  const line = matchResumeFailure(getProfile(sess.agentId), text);
  if (!line) return false;
  // 一次 resume 只判定一次：失敗訊息會留在畫面上，觀察窗留著會讓接下來 20 秒
  // 的每次掃描都早退，狀態偵測就此凍結。
  attempts.delete(sess.id);
  if (attempt.agentSessionId) markResumeFailed(sess.id, attempt.agentSessionId);
  reportResumeFailure(sess, line, scope);
  return true;
}

export function clearResumeState(sessionId: string): void {
  attempts.delete(sessionId);
  failedIds.delete(sessionId);
}

/**
 * 接續失敗 → 一筆 error 提醒，走與其他 agent 事件同一條 routeAlert（通知中心永遠
 * 記錄；桌面通知經 shouldDesktopNotify 的統一 gating，所以「使用者正看著這個
 * pane」時不會被自己按的按鈕彈通知，切走之後才會）。
 *
 * detail 直接用實際訊息（終端那行失敗文字 / 不見了的路徑），不另外造翻譯：
 * agent 自己講的話比我們轉述精確，也不會隨 CLI 改版過期。它同時當去重內容 ——
 * 換了一個不同的失敗原因就該再響一次。
 */
export function reportResumeFailure(sess: Session, detail: string, scope: AlertScope): void {
  routeAlert(sess, "error", { center: detail, dedupe: detail, body: detail }, scope);
}
