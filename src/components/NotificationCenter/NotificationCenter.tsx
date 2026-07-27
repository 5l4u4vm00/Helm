// 通知中心面板：所有提醒事件（三種 waiting / done / error）的 App 內入口
// 與歷史（上限見 NOTIFICATION_CAP，不跨啟動保存）。由 Toolbar 的鈴鐺開關；
// 點項目跳到該 session 並標已讀；Esc 關閉並把焦點還給終端機。
import { useSessionStore } from "../../store/sessions";
import { useNotificationsStore } from "../../store/notifications";
import { useUiStore } from "../../store/ui";
import { activateSession } from "../../commands/actions";
import { focusActiveTerminal, handleDismissKey } from "../../focus/focusUtils";
import { handleListKey, hasNonShiftModifier } from "../../focus/listNav";
import { useT } from "../../i18n";
import type { AppNotification, NotifyKind } from "../../store/notificationCenter";
import "./NotificationCenter.css";

const KIND_ICONS: Record<NotifyKind, string> = {
  approval: "⚠",
  question: "?",
  plan: "☰",
  done: "✓",
  error: "✕",
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Gate component: while the panel is closed only the open flag is subscribed.
export function NotificationCenter() {
  const open = useUiStore((s) => s.notificationsOpen);
  if (!open) return null;
  return <NotificationCenterContent />;
}

function NotificationCenterContent() {
  const t = useT();
  const setOpen = useUiStore((s) => s.setNotificationsOpen);
  const items = useNotificationsStore((s) => s.items);
  const markRead = useNotificationsStore((s) => s.markRead);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const hasUnread = items.some((x) => !x.read);

  const onClose = () => setOpen(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    handleDismissKey(e, () => {
      onClose();
      focusActiveTerminal();
    });
  };

  const onItemClick = (n: AppNotification) => {
    markRead(n.id);
    // session 已關閉的歷史項只標已讀，不跳轉。點擊當下讀 store 即可，
    // 不訂閱 session 列表（面板不必隨 session tick 重繪）。
    const alive = useSessionStore.getState().sessions.some((s) => s.id === n.sessionId);
    if (!alive) return;
    activateSession(n.sessionId);
    onClose();
  };

  // Region layer, same vocabulary as the changed-files list.
  const onItemKey = (e: React.KeyboardEvent, n: AppNotification) => {
    if (hasNonShiftModifier(e)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onItemClick(n);
    } else if (handleListKey(e.key, e.currentTarget.closest(".notif-list"), ".notif-item")) {
      e.preventDefault();
    }
  };

  return (
    <div className="notif-panel" data-focus-region="notifications" onKeyDown={onKeyDown}>
      <div className="notif-header">
        <span>{t("notifCenter.title")}</span>
        <span className="notif-header-actions">
          {hasUnread && (
            <button className="notif-mark-all" onClick={markAllRead}>
              {t("notifCenter.markAllRead")}
            </button>
          )}
          <button className="notif-close" onClick={onClose} title={t("notifCenter.close")}>
            ×
          </button>
        </span>
      </div>
      <div className="notif-list">
        {items.length === 0 && <div className="notif-empty">{t("notifCenter.empty")}</div>}
        {/* 追加序尾端最新 → 反轉呈現（最新在上）。 */}
        {[...items].reverse().map((n, i) => (
          <div
            key={n.id}
            className={`notif-item ${n.read ? "" : "unread"} ${n.resolved ? "resolved" : ""}`}
            role="button"
            // Roving focus: only the newest item is a Tab stop; j/k move from there.
            tabIndex={i === 0 ? 0 : -1}
            data-region-entry={i === 0 ? "" : undefined}
            onClick={() => onItemClick(n)}
            onKeyDown={(e) => onItemKey(e, n)}
          >
            <span className={`notif-icon kind-${n.kind}`}>{KIND_ICONS[n.kind]}</span>
            <div className="notif-main">
              <div className="notif-title">
                {t(`notify.${n.kind}`, { label: n.agentLabel ?? "Agent" })}
              </div>
              {n.text && (
                <div className="notif-text" title={n.text}>
                  {n.text}
                </div>
              )}
              <div className="notif-meta">
                {n.sessionTitle} · {fmtTime(n.createdAt)}
              </div>
            </div>
            {!n.read && <span className="notif-unread-dot" />}
          </div>
        ))}
      </div>
    </div>
  );
}
