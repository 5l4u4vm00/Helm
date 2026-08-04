// 提醒事件的送出路徑：通知中心（永遠記錄）＋ 桌面通知（經統一 gating）。
//
// 為什麼獨立成一個模組：這段邏輯有兩個呼叫端 —— sessions.ts 的狀態轉移事件，以及
// resumeState.ts 的接續失敗。原本後者把整段（含 gating 環境的組裝）複製了一份，
// 因為 sessions.ts 沒有把它 export 出來。複製品最貴的地方不是那幾行，而是「聚焦
// 抑制與去重的規則從此有兩份定義」。
//
// 刻意只 type-only import Session：呼叫端自己把 sessions/activeId 當 scope 傳進來，
// 本模組因此不 import sessions store，也就不會與它形成 import 循環。
import { collectSessionIds } from "./layoutTree";
import { groupTreeOf, useLayoutStore } from "./layout";
import { NOTIFY_TOGGLE_KEYS } from "./notificationCenter";
import { useNotificationsStore } from "./notifications";
import { shouldDesktopNotify, type DesktopNotifyContext } from "./notificationRouter";
import { useSettingsStore } from "./settings";
import { resolveFocusedWorkspace } from "./workspaceGroups";
import type { NotifyKind } from "./notificationCenter";
import type { Session } from "./sessions";
import { notify } from "../ipc/notify";
import { t } from "../i18n";

/** gating 需要的全域環境；由呼叫端從 session store 讀出來傳進來。 */
export interface AlertScope {
  // 非 readonly：resolveFocusedWorkspace 的既有簽名收的是可變陣列。
  sessions: Session[];
  activeId: string | null;
}

/** 桌面通知 gating 所需的環境：類型開關（settings）+ 視窗焦點 + workspace/pane 歸屬。 */
export function desktopNotifyContext(
  sess: Session,
  kind: NotifyKind,
  scope: AlertScope,
): DesktopNotifyContext {
  const st = useSettingsStore.getState();
  const perKind = st[NOTIFY_TOGGLE_KEYS[kind]];
  // 畫面上的 pane = active 的分割群組成員；未分組時只有 active 自己
  //（與 Toolbar 的派工對象同一套定義）。
  const tree = groupTreeOf(useLayoutStore.getState().trees, scope.activeId);
  const visibleIds = tree
    ? collectSessionIds(tree)
    : scope.activeId
      ? [scope.activeId]
      : [];
  return {
    enabled: st.notificationsEnabled && perKind,
    windowFocused: document.hasFocus(),
    inFocusedWorkspace:
      sess.workspaceId === resolveFocusedWorkspace(scope.sessions, scope.activeId),
    paneVisible: visibleIds.includes(sess.id),
    notifyHiddenPanes: st.notifyHiddenPanes,
  };
}

export interface AlertText {
  /** 進通知中心的內文（undefined = 只用 i18n 標題呈現）。 */
  center?: string;
  /**
   * 去重比較用的內容。瞬時事件（done / error / interrupted / stalled）傳 ""，
   * 讓「同一類事件在冷卻期內只響一次」；提示類傳提示文字，換了內容就該再響。
   */
  dedupe: string;
  /** 桌面通知的本文。 */
  body: string;
}

/**
 * 一次事件 → 兩個出口。通知中心永遠記錄（重複入列由 pushNotification 收斂），
 * 桌面通知只走 shouldDesktopNotify 這一道閘門。
 */
export function routeAlert(
  sess: Session,
  kind: NotifyKind,
  text: AlertText,
  scope: AlertScope,
): void {
  useNotificationsStore.getState().push({
    kind,
    sessionId: sess.id,
    sessionTitle: sess.title,
    agentLabel: sess.agentLabel,
    text: text.center,
  });
  const ctx = desktopNotifyContext(sess, kind, scope);
  if (!shouldDesktopNotify(sess.id, kind, text.dedupe, ctx, Date.now())) return;
  notify(sess.id, t(`notify.${kind}`, { label: sess.agentLabel ?? "Agent" }), text.body);
}
