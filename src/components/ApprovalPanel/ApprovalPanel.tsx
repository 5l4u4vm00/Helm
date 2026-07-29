// 集中審批面板：匯總「聚焦 workspace 內」所有等待審批的 agent，一鍵批准/拒絕。
// 批准/拒絕 = 把該 profile 定義的按鍵序列寫回對應 PTY（不攔截 stdin）。
// 其他 workspace 的待審批由側欄徽章與桌面通知提示。
// Buttons share respondApproval with the approval:* commands; Esc returns
// focus to the terminal.
import { useShallow } from "zustand/react/shallow";
import {
  activateSession,
  respondAllApprovals,
  respondApproval,
} from "../../commands/actions";
import { focusActiveTerminal, handleDismissKey } from "../../focus/focusUtils";
import { useSessionStore } from "../../store/sessions";
import { useUiStore } from "../../store/ui";
import {
  pendingPanelPromptsInWorkspace,
  resolveFocusedWorkspace,
} from "../../store/workspaceGroups";
import { useT } from "../../i18n";
import "./ApprovalPanel.css";

export function ApprovalPanel() {
  const t = useT();
  // 窄訂閱：未動到的 session 物件引用穩定，shallow 比對讓其他 session 的
  // usage/state tick（PTY 輸出頻率）不會重繪整個面板。
  const pending = useSessionStore(
    useShallow((s) =>
      pendingPanelPromptsInWorkspace(s.sessions, resolveFocusedWorkspace(s.sessions, s.activeId)),
    ),
  );
  const collapsed = useUiStore((s) => s.approvalCollapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleApprovalCollapsed);
  if (pending.length === 0) return null;
  const approvals = pending.filter((s) => Boolean(s.pendingApproval));

  // Escape only leaves the panel: it stays visible while approvals are pending.
  const onKeyDown = (e: React.KeyboardEvent) => {
    handleDismissKey(e, focusActiveTerminal);
  };

  const onMetaKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateSession(id);
    }
  };

  return (
    <div
      className={collapsed ? "approval-panel collapsed" : "approval-panel"}
      data-focus-region="approvals"
      onKeyDown={onKeyDown}
    >
      <div className="approval-header">
        {t("approval.pending")} <span className="approval-count">{pending.length}</span>
        {!collapsed && approvals.length > 1 && (
          <span className="approval-batch">
            <button className="batch approve" onClick={() => respondAllApprovals(true)}>
              {t("approval.approveAll")}
            </button>
            <button className="batch reject" onClick={() => respondAllApprovals(false)}>
              {t("approval.rejectAll")}
            </button>
          </span>
        )}
        <button
          className="approval-collapse"
          title={collapsed ? t("approval.expand") : t("approval.collapse")}
          aria-label={collapsed ? t("approval.expand") : t("approval.collapse")}
          onClick={toggleCollapsed}
        >
          {collapsed ? "+" : "–"}
        </button>
      </div>
      {!collapsed && (
      <div className="approval-content">
        {pending.map((s) => (
          <div className="approval-item" key={s.id}>
            <div
              className="approval-meta"
              role="button"
              tabIndex={0}
              onClick={() => activateSession(s.id)}
              onKeyDown={(e) => onMetaKeyDown(e, s.id)}
            >
              <span className="approval-agent">{s.agentLabel ?? t("toolbar.defaultAgent")}</span>
              <span className="approval-session">{s.title}</span>
            </div>
            <div className="approval-prompt" title={s.pendingApproval ?? s.pendingPrompt?.text}>
              {s.pendingApproval ?? s.pendingPrompt?.text}
            </div>
            <div className="approval-actions">
              {s.pendingApproval ? (
                <>
                  <button
                    className="approve"
                    onClick={() => respondApproval(s.id, s.agentId, true)}
                  >
                    {t("approval.approve")}
                  </button>
                  <button
                    className="reject"
                    onClick={() => respondApproval(s.id, s.agentId, false)}
                  >
                    {t("approval.reject")}
                  </button>
                </>
              ) : (
                <button className="answer" onClick={() => activateSession(s.id)}>
                  {t("approval.answer")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
