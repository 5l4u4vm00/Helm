// 頂部工具列：左側是全局艦隊狀態 chips（誰在跑/誰在等你，點擊輪替跳轉），
// 右側是方案剩餘額度 meter、active session 用量、變更/通知入口。
// planUsage 是帳號級（statusline rate_limits，跨 session 同一份），讀 store 的
// 全域最新值、只要存在就顯示；變更計數則限縮在聚焦 workspace 內。
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "../../store/sessions";
import { FLEET_STATES, fleetCounts, type FleetState } from "../../store/fleet";
import { activateNextInFleetState } from "../../commands/actions";
import { useNotificationsStore } from "../../store/notifications";
import { unreadCount } from "../../store/notificationCenter";
import { useUiStore } from "../../store/ui";
import { installPendingUpdate, useUpdateStore } from "../../store/update";
import {
  resolveFocusedWorkspace,
  workspaceChangedFileCount,
} from "../../store/workspaceGroups";
import type { PlanUsage } from "../../agents/hookEvents";
import { useT } from "../../i18n";
import "./Toolbar.css";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function fmtNum(n?: number): string {
  return n === undefined ? "—" : n.toLocaleString();
}

// 方案速率限制剩餘：至少有一個視窗（5h / 週）帶剩餘 % 才顯示。
function hasPlanUsage(pu?: PlanUsage): boolean {
  return (
    !!pu && (pu.fiveHourLeftPercent !== undefined || pu.sevenDayLeftPercent !== undefined)
  );
}

function fmtResetTime(unixSec?: number): string | undefined {
  if (unixSec === undefined) return undefined;
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// meter 顏色門檻：剩餘 ≤10% 紅、≤25% 黃、其餘綠（CSS 依 data-level 上色）。
function meterLevel(percent: number): "ok" | "warn" | "low" {
  if (percent <= 10) return "low";
  if (percent <= 25) return "warn";
  return "ok";
}

/** 單一額度視窗的迷你進度條 + 剩餘 % 文字，tooltip 帶重置時間。 */
function UsageMeter({
  text,
  percent,
  resetsAt,
  t,
}: {
  text: string;
  percent: number;
  resetsAt?: number;
  t: Translate;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  const reset = fmtResetTime(resetsAt);
  const title = reset
    ? `${t("toolbar.planUsage")} · ${t("toolbar.planUsageReset", { time: reset })}`
    : t("toolbar.planUsage");
  return (
    <span className="tb-meter tb-mono" data-level={meterLevel(pct)} title={title}>
      <span className="tb-meter-track">
        <span className="tb-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      {text}
    </span>
  );
}

const FLEET_LABEL_KEY: Record<FleetState, string> = {
  busy: "toolbar.fleetBusy",
  waiting: "toolbar.fleetWaiting",
  error: "toolbar.fleetError",
  done: "toolbar.fleetDone",
};

export function Toolbar() {
  const t = useT();
  const filesOpen = useUiStore((s) => s.filesOpen);
  const toggleFiles = useUiStore((s) => s.toggleFiles);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const notifOpen = useUiStore((s) => s.notificationsOpen);
  const toggleNotifications = useUiStore((s) => s.toggleNotifications);
  const unread = useNotificationsStore((s) => unreadCount(s.items));
  const updatePhase = useUpdateStore((s) => s.phase);
  const updateVersion = useUpdateStore((s) => s.version);
  const updateDismissed = useUpdateStore((s) => s.dismissed);
  const dismissUpdate = useUpdateStore((s) => s.dismiss);

  // 窄訂閱（值/引用沒變就不重繪）：fleet/變更數是 primitive；active 只投影
  // 工具列實際顯示的欄位（shallow 比對擋掉無關 tick）。
  const fleet = useSessionStore(useShallow((s) => fleetCounts(s.sessions)));
  const sessionCount = useSessionStore((s) => s.sessions.length);
  const planUsage = useSessionStore((s) => s.accountPlanUsage);
  const changedCount = useSessionStore((s) =>
    workspaceChangedFileCount(s.sessions, resolveFocusedWorkspace(s.sessions, s.activeId)),
  );
  const active = useSessionStore(
    useShallow((s) => {
      const a = s.sessions.find((x) => x.id === s.activeId);
      return (
        a && {
          agentId: a.agentId,
          agentLabel: a.agentLabel,
          tokensIn: a.tokensIn,
          tokensOut: a.tokensOut,
          contextLeftPercent: a.contextLeftPercent,
        }
      );
    }),
  );

  const showPlan = hasPlanUsage(planUsage);

  return (
    <div className="toolbar" data-focus-region="toolbar">
      {/* 側欄的「隱藏」入口在側欄自身右緣（«）；帶回的入口放工具列最左端
          （側欄原本的位置），只在隱藏時顯示。 */}
      {sidebarHidden && (
        <button className="tb-files" onClick={toggleSidebar} title={t("toolbar.showSidebar")}>
          ☰
        </button>
      )}

      {/* 艦隊狀態：灰字總數恆在；非零狀態才長出 chip，點擊輪替跳到下一個
          該狀態的 session（sidebar 視覺順序，環繞）。 */}
      <div className="tb-fleet">
        <span className="tb-fleet-count">
          {t("toolbar.fleetSessions", { count: sessionCount })}
        </span>
        {FLEET_STATES.some((st) => fleet[st] > 0) && <span className="tb-divider" />}
        {FLEET_STATES.filter((st) => fleet[st] > 0).map((st) => (
          <button
            key={st}
            className="tb-chip"
            data-state={st}
            title={t("toolbar.fleetJump")}
            onClick={() => activateNextInFleetState(st)}
          >
            <span className="tb-chip-dot" />
            {t(FLEET_LABEL_KEY[st], { count: fleet[st] })}
          </button>
        ))}
      </div>

      <div className="tb-spacer" />

      {updatePhase === "available" && !updateDismissed && (
        <div className="tb-update-banner">
          <span>{t("update.available", { version: updateVersion ?? "" })}</span>
          <button className="tb-update-install" onClick={() => void installPendingUpdate()}>
            {t("update.installNow")}
          </button>
          <button className="tb-update-later" onClick={dismissUpdate}>
            {t("update.later")}
          </button>
        </div>
      )}

      {(updatePhase === "downloading" || updatePhase === "relaunching") && (
        <span className="tb-update" title={t(`update.${updatePhase}`, { version: updateVersion ?? "" })}>
          {t(`update.${updatePhase}`, { version: updateVersion ?? "" })}
        </span>
      )}

      {(showPlan || active?.agentId) && (
        <div className="tb-usage">
          {/* Claude Code 的方案額度屬於帳號，不應遮住目前 pane（例如 Codex）的
              session 統計。兩者各自成組，並排顯示。 */}
          {showPlan && (
            <div className="tb-usage-group">
              <span className="tb-agent">Claude Code</span>
              {planUsage!.fiveHourLeftPercent !== undefined && (
                <UsageMeter
                  text={t("toolbar.planUsage5h", {
                    percent: Math.round(planUsage!.fiveHourLeftPercent),
                  })}
                  percent={planUsage!.fiveHourLeftPercent}
                  resetsAt={planUsage!.fiveHourResetsAt}
                  t={t}
                />
              )}
              {planUsage!.sevenDayLeftPercent !== undefined && (
                <UsageMeter
                  text={t("toolbar.planUsageWeek", {
                    percent: Math.round(planUsage!.sevenDayLeftPercent),
                  })}
                  percent={planUsage!.sevenDayLeftPercent}
                  resetsAt={planUsage!.sevenDayResetsAt}
                  t={t}
                />
              )}
            </div>
          )}
          {active?.agentId && (
            <div className="tb-usage-group">
              <span className="tb-agent">{active.agentLabel ?? t("toolbar.defaultAgent")}</span>
              {active.contextLeftPercent !== undefined ? (
                <span className="tb-mono" title={t("toolbar.contextLeft")}>
                  {t("toolbar.contextLeftValue", { percent: active.contextLeftPercent })}
                </span>
              ) : (
                <span className="tb-mono" title={t("toolbar.tokens")}>
                  ↑{fmtNum(active.tokensIn)} ↓{fmtNum(active.tokensOut)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <button
        className={`tb-files ${filesOpen ? "on" : ""}`}
        aria-pressed={filesOpen}
        onClick={toggleFiles}
        title={t("toolbar.changedFiles")}
      >
        {t("toolbar.changedFilesLabel", { count: changedCount })}
      </button>
      <button
        className={`tb-files tb-bell ${notifOpen ? "on" : ""}`}
        aria-pressed={notifOpen}
        onClick={toggleNotifications}
        title={t("toolbar.notifications")}
      >
        🔔
        {unread > 0 && <span className="tb-bell-badge">{unread}</span>}
      </button>
    </div>
  );
}
