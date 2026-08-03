// 提醒事件的單一路由（純函式 + module-level 去重狀態；type-only import，
// node 測試可直接載入）。兩個職責：
// 1. detectAgentEvent —— 從 agent 狀態轉移邊緣判斷「值得提醒的事件」。
// 2. shouldDesktopNotify —— 桌面通知的統一 gating（開關 → 聚焦抑制 → 去重
//    冷卻），取代原本分散在 sessions.ts / approvalNotify.ts 的判斷。
import type { AgentState, PromptKind } from "../agents/types";
// .ts 副檔名：isWaitingKind 是執行期 import（不再是 type-only），node 的
// strip-types 模式需要明確副檔名才解析得到。
import { isWaitingKind, type NotifyKind } from "./notificationCenter.ts";

/** done / error 只在「真的跑過」之後提醒：前一狀態必須是忙碌中。 */
const BUSY_STATES: readonly AgentState[] = ["thinking", "tool", "waiting"];

/**
 * 這個狀態算不算「agent 正在工作」。除了本檔的邊緣判定，也是
 * markInterrupted / stale-busy watchdog 的判斷依據 —— 三處必須同一套定義，
 * 否則「工作中被中斷」的門檻會各自漂移。
 */
export function isBusyState(state: AgentState | undefined): boolean {
  return state !== undefined && BUSY_STATES.includes(state);
}

/**
 * 狀態轉移 → 提醒事件。規則：
 * - 進入 waiting（prev ≠ waiting）→ promptKind（approval / question / plan）。
 * - 忙碌（thinking / tool / waiting）→ done / error → 對應事件。
 *   `undefined → done` 不算：agent 剛被偵測到時，殘留 transcript 推導出的
 *   done 不是一次真實回合的結束。
 * - 其餘轉移（含 waiting 中換提示文字）不提醒，維持既有邊緣語意。
 */
export function detectAgentEvent(
  prev: AgentState | undefined,
  next: AgentState | undefined,
  promptKind: PromptKind,
): NotifyKind | null {
  if (prev === next) return null;
  if (next === "waiting") return promptKind;
  if ((next === "done" || next === "error") && prev !== undefined && BUSY_STATES.includes(prev)) {
    return next;
  }
  return null;
}

/** 同 session+kind 的相同內容，冷卻期內不重發（state flapping 抑制）。 */
export const NOTIFY_COOLDOWN_MS = 120_000;

/** 每個 session+kind 最近一次已送出的桌面通知。 */
const lastNotified = new Map<string, { text: string; at: number }>();

function dedupeKey(sessionId: string, kind: NotifyKind): string {
  return `${sessionId}:${kind}`;
}

/** 呼叫端注入的環境（settings / DOM focus / workspace 歸屬），保持本模組純粹。 */
export interface DesktopNotifyContext {
  /** 總開關 && 該事件類型的開關。 */
  enabled: boolean;
  windowFocused: boolean;
  /** session 是否在聚焦 workspace（waiting 類的提示此時已在畫面上）。 */
  inFocusedWorkspace: boolean;
  /** session 的終端 pane 是否在畫面上（active 分割群組成員或 active 本身）。 */
  paneVisible: boolean;
  /** 設定開關：聚焦時畫面外 pane 的 waiting / error 仍發通知。 */
  notifyHiddenPanes: boolean;
}

/**
 * 這筆事件該不該發桌面通知。抑制檢查在去重記錄之前：被抑制的通知不留
 * 紀錄，之後失焦（App.tsx 的 blur 補發）仍可送出。規則：
 * - 開關關閉 → 不發。
 * - waiting 類：視窗聚焦時，notifyHiddenPanes 開啟 → 只有 pane 在畫面上才
 *   抑制（提示就在終端裡）；關閉 → 沿用舊規則，聚焦 workspace 即抑制
 *   （ApprovalPanel / 側欄徽章已在畫面上），其他 workspace 仍要發。
 * - error / interrupted / stalled：視窗聚焦時，notifyHiddenPanes 開啟且 pane
 *   不在畫面上 → 仍發；否則抑制。三者共用同一條規則 —— 它們都是「出事了、
 *   但畫面上不一定看得出來」的事件。
 * - done：視窗聚焦即抑制（狀態點與通知中心已足夠）。
 * - 通過後查去重：同 session+kind 的相同內容於冷卻期內不重發。
 */
export function shouldDesktopNotify(
  sessionId: string,
  kind: NotifyKind,
  text: string,
  ctx: DesktopNotifyContext,
  now: number,
): boolean {
  if (!ctx.enabled) return false;
  if (ctx.windowFocused) {
    if (kind === "done") return false;
    if (!isWaitingKind(kind)) {
      if (!ctx.notifyHiddenPanes || ctx.paneVisible) return false;
    } else if (ctx.notifyHiddenPanes ? ctx.paneVisible : ctx.inFocusedWorkspace) {
      return false;
    }
  }
  const key = dedupeKey(sessionId, kind);
  const last = lastNotified.get(key);
  if (last && last.text === text && now - last.at < NOTIFY_COOLDOWN_MS) return false;
  lastNotified.set(key, { text, at: now });
  return true;
}

/**
 * 清掉該 session 的去重紀錄。呼叫點沿用原 clearApprovalNotify：使用者明確
 * 回應審批（相同文字的新審批必須立即再通知）與 session 關閉。刻意不在
 * clearApproval / setAgentState 呼叫 —— 那是 flapping 走的路徑。
 */
export function clearNotifyDedupe(sessionId: string): void {
  for (const key of lastNotified.keys()) {
    if (key.startsWith(`${sessionId}:`)) lastNotified.delete(key);
  }
}
