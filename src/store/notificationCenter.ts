// 通知中心的純列表操作（無執行期 import，node 測試可直接載入）。
// 每筆通知對應一次「值得提醒的 agent 事件」：三種 waiting（approval /
// question / plan）、done、error、interrupted、stalled。waiting 類在被回答/
// 清除前為 unresolved；其餘都是瞬時事件，建立時即 resolved（只剩已讀/未讀
// 之分）。
//
// interrupted / stalled 與 done / error 的來源不同：後兩者由狀態轉移邊緣推
// 導（detectAgentEvent），前兩者是明確呼叫發出的 —— agent 工作中 PTY 死掉
// 沒有「轉移」可偵測（那正是它以前完全靜默的原因），停滯更是「什麼都沒發
// 生」。

export type NotifyKind =
  | "approval"
  | "question"
  | "plan"
  | "done"
  | "error"
  | "interrupted"
  | "stalled";

/**
 * 需要使用者回應的事件類型。這些通知在被回答/清除前保持 unresolved，桌面
 * 通知也走另一套聚焦抑制規則（見 shouldDesktopNotify）。
 * 定義在此而非 notificationRouter，讓 notifications store 不必反向 import
 * router 就能決定 resolved 初值。
 */
export const WAITING_KINDS: readonly NotifyKind[] = ["approval", "question", "plan"];

export function isWaitingKind(kind: NotifyKind): boolean {
  return WAITING_KINDS.includes(kind);
}

export interface AppNotification {
  id: string;
  kind: NotifyKind;
  sessionId: string;
  sessionTitle: string;
  agentLabel?: string;
  /** waiting 類的提示行；done / error 無內文（渲染時以 i18n 標題呈現）。 */
  text?: string;
  createdAt: number;
  read: boolean;
  resolved: boolean;
}

/** 歷史上限：超過即丟最舊（列表為追加序，尾端最新）。 */
export const NOTIFICATION_CAP = 50;

/**
 * 追加一筆通知。State flapping（同一提示在重繪間反覆觸發邊緣）會以相同
 * 內容重複進來：同 session+kind+text 已有「未解決或未讀」的項目時跳過，
 * 讓風暴收斂成一筆。回傳新陣列；跳過時回傳原參照（呼叫端可短路）。
 */
export function pushNotification(
  list: AppNotification[],
  n: AppNotification,
): AppNotification[] {
  const dup = list.some(
    (x) =>
      x.sessionId === n.sessionId &&
      x.kind === n.kind &&
      x.text === n.text &&
      (!x.resolved || !x.read),
  );
  if (dup) return list;
  const next = [...list, n];
  return next.length > NOTIFICATION_CAP ? next.slice(next.length - NOTIFICATION_CAP) : next;
}

/**
 * 該 session 的 waiting 類通知已被回答/清除 → 標為 resolved + read。
 * 沒有可標的項目時回傳原參照（zustand set 可據此不觸發重繪）。
 */
export function resolveSessionNotifications(
  list: AppNotification[],
  sessionId: string,
): AppNotification[] {
  if (!list.some((x) => x.sessionId === sessionId && !x.resolved)) return list;
  return list.map((x) =>
    x.sessionId === sessionId && !x.resolved ? { ...x, resolved: true, read: true } : x,
  );
}

/** 標單筆已讀；無此 id 或已讀時回傳原參照。 */
export function markNotificationRead(
  list: AppNotification[],
  id: string,
): AppNotification[] {
  if (!list.some((x) => x.id === id && !x.read)) return list;
  return list.map((x) => (x.id === id ? { ...x, read: true } : x));
}

/** 全部標已讀；本來就全已讀時回傳原參照。 */
export function markAllNotificationsRead(list: AppNotification[]): AppNotification[] {
  if (!list.some((x) => !x.read)) return list;
  return list.map((x) => (x.read ? x : { ...x, read: true }));
}

export function unreadCount(list: AppNotification[]): number {
  return list.reduce((n, x) => (x.read ? n : n + 1), 0);
}
