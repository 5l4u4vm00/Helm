// One session row: status dot, title, close button.
// Draggable so it can be dropped onto another workspace group.
// Memoized: projected session refs (sidebarProjection) are stable for
// untouched sessions and cluster info arrives as primitives, so one session's
// state tick re-renders only its own row.
import { memo } from "react";
import { useSessionStore } from "../../store/sessions";
import { useUiStore } from "../../store/ui";
import type { SidebarSession } from "../../store/sidebarProjection";
import type { SplitClusterInfo } from "../../store/workspaceGroups";
import { activateSession, newSession } from "../../commands/actions";
import { focusActiveTerminal } from "../../focus/focusUtils";
import { handleListKey } from "../../focus/listNav";
import { useT } from "../../i18n";

/** Roving-focus targets in the sidebar: session rows, plus workspace
 *  headers that have no visible session rows (collapsed or empty — marked
 *  data-nav-stop) so every workspace stays keyboard-reachable; headers with
 *  visible sessions are skipped by j/k and entered/left via h/l. */
export const SIDEBAR_NAV_SELECTOR = ".session-item, .workspace-header[data-nav-stop]";

// 綜合狀態燈：有 agent 狀態優先，否則用活動狀態。
function dotClass(s: SidebarSession): string {
  if (s.agentState) return `agent-${s.agentState}`;
  return s.status;
}

const stateLabelKeys: Record<string, string> = {
  "agent-thinking": "sidebar.state.thinking",
  "agent-tool": "sidebar.state.tool",
  "agent-waiting": "sidebar.state.waiting",
  "agent-done": "sidebar.state.done",
  "agent-error": "sidebar.state.error",
  busy: "sidebar.state.busy",
  idle: "sidebar.state.idle",
  exited: "sidebar.state.exited",
};

interface SessionItemProps {
  session: SidebarSession;
  clusterPos: SplitClusterInfo["position"];
  clusterGroupId: string | null;
  isActive: boolean;
  listRef: React.RefObject<HTMLDivElement | null>;
}

export const SessionItem = memo(function SessionItem({
  session: s,
  clusterPos,
  clusterGroupId,
  isActive,
  listRef,
}: SessionItemProps) {
  const t = useT();
  const closeSession = useSessionStore((x) => x.closeSession);
  const renameSession = useSessionStore((x) => x.renameSession);
  // Rename state comes from the ui store (not props) so this memo still skips
  // rows whose own state didn't tick — same reasoning as WorkspaceGroup.
  const renaming = useUiStore((x) => x.renamingSessionId === s.id);
  const setRenamingId = useUiStore((x) => x.setRenamingSessionId);
  const onRenameStart = () => setRenamingId(s.id);
  const onRenameEnd = () => setRenamingId(null);

  const commitRename = (value: string) => {
    renameSession(s.id, value);
    onRenameEnd();
  };

  const onRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") commitRename(e.currentTarget.value);
    else if (e.key === "Escape") onRenameEnd();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateSession(s.id);
    } else if (e.key === "Delete" || e.key === "Backspace" || e.key === "d") {
      e.preventDefault();
      closeSession(s.id);
    } else if (e.key === "h" || e.key === "ArrowLeft") {
      // Tree-view collapse direction: jump up to the owning workspace header.
      e.preventDefault();
      e.currentTarget
        .closest(".workspace-group")
        ?.querySelector<HTMLElement>(".workspace-header")
        ?.focus();
    } else if (e.key === "a") {
      e.preventDefault();
      newSession(undefined, s.workspaceId);
    } else if (e.key === "F2" || e.key === "r") {
      e.preventDefault();
      onRenameStart();
    } else if (e.key === "Escape") {
      e.preventDefault();
      focusActiveTerminal();
    } else if (handleListKey(e.key, listRef.current, SIDEBAR_NAV_SELECTOR)) {
      e.preventDefault();
    }
  };

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", s.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const cls = dotClass(s);
  return (
    <div
      className={`session-item ${isActive ? "active" : ""}`}
      role="button"
      tabIndex={isActive ? 0 : -1}
      data-region-entry={isActive ? "true" : undefined}
      data-cluster-pos={clusterPos}
      data-cluster-group={clusterGroupId ?? undefined}
      // A draggable ancestor breaks text selection inside the input in WebKit.
      draggable={!renaming}
      onDragStart={onDragStart}
      onClick={() => {
        if (!renaming) activateSession(s.id);
      }}
      onDoubleClick={() => {
        if (!renaming) onRenameStart();
      }}
      onKeyDown={onKeyDown}
    >
      <span className={`status-dot ${cls}`} title={cls in stateLabelKeys ? t(stateLabelKeys[cls]) : ""} />
      {renaming ? (
        <input
          className="session-rename-input"
          defaultValue={s.title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onRenameKeyDown}
          onBlur={(e) => commitRename(e.currentTarget.value)}
        />
      ) : (
        <span className="session-name" title={t("sidebar.renameSession")}>
          {s.title}
        </span>
      )}
      <button
        className="icon-btn close"
        title={t("sidebar.close")}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          closeSession(s.id);
        }}
      >
        ×
      </button>
    </div>
  );
});
