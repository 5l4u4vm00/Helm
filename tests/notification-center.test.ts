// 通知中心純列表操作的測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/notification-center.test.ts
import assert from "node:assert";
import {
  NOTIFICATION_CAP,
  isWaitingKind,
  markAllNotificationsRead,
  markNotificationRead,
  pushNotification,
  resolveSessionNotifications,
  unreadCount,
  type AppNotification,
  type NotifyKind,
} from "../src/store/notificationCenter.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

let seq = 0;
function make(over: Partial<AppNotification> & { kind: NotifyKind }): AppNotification {
  seq += 1;
  return {
    id: `n${seq}`,
    sessionId: "s1",
    sessionTitle: "Session 1",
    createdAt: seq,
    read: false,
    // 鏡射 notifications.ts 的 push：非 waiting 類建立時即 resolved。
    resolved: !isWaitingKind(over.kind),
    ...over,
  };
}

// ---- isWaitingKind：resolved 初值與桌面通知規則的共同依據 ----

check(
  "waiting 三類",
  (["approval", "question", "plan"] as const).every((k) => isWaitingKind(k)),
);
check(
  "瞬時事件不是 waiting",
  (["done", "error", "interrupted", "stalled"] as const).every((k) => !isWaitingKind(k)),
);

// ---- interrupted / stalled：無內文的瞬時事件 ----

{
  let list: AppNotification[] = [];
  list = pushNotification(list, make({ kind: "interrupted", sessionId: "sx" }));
  check("interrupted 建立時即 resolved", list[0].resolved && !list[0].read);
  const again = pushNotification(list, make({ kind: "interrupted", sessionId: "sx" }));
  check("同 session 的 interrupted 未讀時收斂成一筆", again === list);
  list = pushNotification(list, make({ kind: "stalled", sessionId: "sx" }));
  check("stalled 是不同 kind，另計一筆", list.length === 2);
}

// ---- pushNotification：去重 + 上限 ----

{
  let list: AppNotification[] = [];
  list = pushNotification(list, make({ kind: "approval", text: "Run ls?" }));
  check("首筆入列", list.length === 1);

  const dup = pushNotification(list, make({ kind: "approval", text: "Run ls?" }));
  check("同 session+kind+text 未解決 → 跳過且回原參照", dup === list);

  list = pushNotification(list, make({ kind: "approval", text: "Delete?" }));
  check("不同 text 入列", list.length === 2);

  list = pushNotification(list, make({ kind: "question", text: "Run ls?" }));
  check("不同 kind 入列", list.length === 3);

  list = pushNotification(list, make({ kind: "approval", text: "Run ls?", sessionId: "s2" }));
  check("不同 session 入列", list.length === 4);
}

// done：resolved 但未讀時仍擋重複；已讀後同內容可再入列
{
  let list: AppNotification[] = [];
  list = pushNotification(list, make({ kind: "done" }));
  const dup = pushNotification(list, make({ kind: "done" }));
  check("done 未讀 → 同內容跳過（flapping 抑制）", dup === list);

  list = markNotificationRead(list, list[0].id);
  list = pushNotification(list, make({ kind: "done" }));
  check("done 已讀後同內容可再入列（新回合）", list.length === 2);
}

// waiting 已解決後，相同提示的新審批可再入列
{
  let list: AppNotification[] = [];
  list = pushNotification(list, make({ kind: "approval", text: "Apply?" }));
  list = resolveSessionNotifications(list, "s1");
  list = pushNotification(list, make({ kind: "approval", text: "Apply?" }));
  check("resolved 後同提示可再入列", list.length === 2);
}

// 上限：超過 NOTIFICATION_CAP 丟最舊
{
  let list: AppNotification[] = [];
  for (let i = 0; i < NOTIFICATION_CAP + 5; i++) {
    list = pushNotification(list, make({ kind: "approval", text: `p${i}`, read: true, resolved: true }));
  }
  check("長度不超過上限", list.length === NOTIFICATION_CAP);
  check("最舊的被丟掉", list[0].text === "p5");
}

// ---- resolveSessionNotifications ----

{
  let list: AppNotification[] = [];
  list = pushNotification(list, make({ kind: "approval", text: "A?" }));
  list = pushNotification(list, make({ kind: "question", text: "B?", sessionId: "s2" }));
  const resolved = resolveSessionNotifications(list, "s1");
  check("目標 session 標 resolved+read", resolved[0].resolved && resolved[0].read);
  check("其他 session 不受影響", !resolved[1].resolved && !resolved[1].read);
  check("無可標項目時回原參照", resolveSessionNotifications(resolved, "s1") === resolved);
}

// ---- markRead / markAllRead / unreadCount ----

{
  let list: AppNotification[] = [];
  list = pushNotification(list, make({ kind: "approval", text: "A?" }));
  list = pushNotification(list, make({ kind: "done" }));
  check("unreadCount 計未讀", unreadCount(list) === 2);

  list = markNotificationRead(list, list[0].id);
  check("markRead 單筆", unreadCount(list) === 1 && list[0].read);
  check("markRead 無效 id 回原參照", markNotificationRead(list, "nope") === list);

  list = markAllNotificationsRead(list);
  check("markAllRead 全已讀", unreadCount(list) === 0);
  check("已全讀時回原參照", markAllNotificationsRead(list) === list);
}

console.log(`\n${passed} checks passed.`);
