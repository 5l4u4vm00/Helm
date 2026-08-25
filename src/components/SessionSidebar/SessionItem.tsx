// One session row: status dot, title, close button.
// Draggable so it can be dropped onto another workspace group.
// Memoized: projected session refs (sidebarProjection) are stable for
// untouched sessions and cluster info arrives as primitives, so one session's
// state tick re-renders only its own row.
import { memo } from "react";
import { useSessionStore } from "../../store/sessions";
import { useUiStore } from "../../store/ui";
import { useWorkspaceStore } from "../../store/workspaces";
import type { SidebarSession } from "../../store/sidebarProjection";
import type { SplitClusterInfo } from "../../store/workspaceGroups";
import {
  activateSession,
  moveSessionInSidebar,
  newSession,
  newWorkspace,
} from "../../commands/actions";
import { focusActiveTerminal } from "../../focus/focusUtils";
import { handleListKey, hasNonShiftModifier } from "../../focus/listNav";
import { pickFolder } from "../../ipc/dialog";
import { useT } from "../../i18n";
import { SESSION_DND_TYPE } from "./dropPosition";
import { resolveSidebarShortcut } from "./sidebarKeymap";

/** Every visible tree node participates in roving focus. */
export const SIDEBAR_NAV_SELECTOR = ".session-item, .workspace-header";

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
  const setRenamingWorkspaceId = useUiStore((x) => x.setRenamingWorkspaceId);
  const pendingAction = useUiStore((x) => x.sidebarPendingAction);
  const setPendingAction = useUiStore((x) => x.setSidebarPendingAction);
  const workspaces = useWorkspaceStore((x) => x.workspaces);
  const setWorkspaceFolder = useWorkspaceStore((x) => x.setWorkspaceFolder);
  const onRenameStart = () => setRenamingId(s.id);
  const onRenameEnd = () => setRenamingId(null);
  const confirming = pendingAction?.kind === "close-session" && pendingAction.id === s.id;

  const commitRename = (value: string) => {
    renameSession(s.id, value);
    onRenameEnd();
  };

  const onRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") commitRename(e.currentTarget.value);
    else if (e.key === "Escape") onRenameEnd();
  };

  const chooseFolder = async () => {
    const folder = workspaces.find((w) => w.id === s.workspaceId)?.folder;
    const path = await pickFolder(folder);
    if (path) setWorkspaceFolder(s.workspaceId, path);
  };

  const focusAfterRemoval = (index: number) => {
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLElement>(SIDEBAR_NAV_SELECTOR) ?? [];
      const next = items[Math.min(index, items.length - 1)];
      if (next) next.focus();
      else focusActiveTerminal();
    });
  };

  const requestClose = () => setPendingAction({ kind: "close-session", id: s.id });

  // `row` is the focused/clicked session row — used to keep roving focus on the
  // same list position after the row disappears.
  const confirmClose = (row: HTMLElement | null) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>(SIDEBAR_NAV_SELECTOR) ?? [])];
    const index = row ? items.indexOf(row) : -1;
    setPendingAction(null);
    closeSession(s.id);
    focusAfterRemoval(Math.max(index, 0));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    // A pending confirmation captures the next key: confirm, cancel, or
    // cancel-and-swallow. Same rule as the armed prefix — a key that cancels
    // must not also run its own action.
    if (confirming) {
      e.preventDefault();
      if (e.key === "Enter" || e.key === " ") {
        confirmClose(e.currentTarget);
        return;
      }
      setPendingAction(null);
      return;
    }
    const action = resolveSidebarShortcut("session", e);
    if (action) {
      e.preventDefault();
      if (action === "activate-session") activateSession(s.id);
      else if (action === "focus-parent") {
        e.currentTarget
          .closest(".workspace-group")
          ?.querySelector<HTMLElement>(".workspace-header")
          ?.focus();
      } else if (action === "rename") onRenameStart();
      else if (action === "new-session") newSession(undefined, s.workspaceId);
      else if (action === "new-workspace") setRenamingWorkspaceId(newWorkspace());
      else if (action === "choose-folder") void chooseFolder();
      else if (action === "request-delete") requestClose();
      else if (action === "focus-terminal") focusActiveTerminal();
      else if (action === "move-up") moveRow(e.currentTarget, -1);
      else if (action === "move-down") moveRow(e.currentTarget, 1);
    } else if (
      !hasNonShiftModifier(e) &&
      handleListKey(e.key, listRef.current, SIDEBAR_NAV_SELECTOR)
    ) {
      e.preventDefault();
    }
  };

  // Focus stays on the row across a reorder (React moves the keyed DOM node
  // rather than recreating it), so the browser will not auto-scroll the list —
  // do it explicitly, after the re-render has placed the row.
  const moveRow = (row: HTMLElement, delta: 1 | -1) => {
    moveSessionInSidebar(s.id, delta);
    requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
  };

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(SESSION_DND_TYPE, s.id);
    // Kept alongside the typed payload so dragging a row onto a text field
    // still yields something sane.
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
      data-session-id={s.id}
      data-cluster-pos={clusterPos}
      data-cluster-group={clusterGroupId ?? undefined}
      // A draggable ancestor breaks text selection inside the input in WebKit.
      draggable={!renaming && !confirming}
      onDragStart={onDragStart}
      // Rename starts on the second mousedown, not on dblclick: WebKitGTK hands
      // the gesture to the drag machinery once `draggable` is set, and the
      // dblclick event never arrives (same family of WebKit quirks as the
      // selection note above). mousedown still fires, and detail === 2 is
      // exactly "second click of a double-click".
      onMouseDown={(e) => {
        if (e.detail === 2 && e.button === 0 && !renaming && !confirming) {
          e.preventDefault();
          onRenameStart();
        }
      }}
      onClick={() => {
        // While confirming, a click anywhere outside the ✓/✕ buttons cancels —
        // the mouse equivalent of the cancel-and-swallow key rule.
        if (confirming) setPendingAction(null);
        else if (!renaming) activateSession(s.id);
      }}
      onKeyDown={onKeyDown}
    >
      <span className={`status-dot ${cls}`} title={cls in stateLabelKeys ? t(stateLabelKeys[cls]) : ""} />
      {confirming ? (
        <>
          <span className="sidebar-inline-confirm">{t("sidebar.confirmClose")}</span>
          <button
            className="icon-btn confirm-yes"
            title={t("sidebar.confirmYes")}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              confirmClose(e.currentTarget.closest<HTMLElement>(".session-item"));
            }}
          >
            ✓
          </button>
          <button
            className="icon-btn confirm-no"
            title={t("sidebar.confirmNo")}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              setPendingAction(null);
              e.currentTarget.closest<HTMLElement>(".session-item")?.focus();
            }}
          >
            ✕
          </button>
        </>
      ) : renaming ? (
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
        /* Full title first, rename hint after (same value+hint tooltip shape
           as the workspace folder line): agent CLIs write 40-char titles that
           the row clips, and the clipped part is the informative half. */
        <span
          className="session-name"
          title={`${s.title}\n${t("sidebar.renameSession")}`}
        >
          {s.title}
        </span>
      )}
      {!confirming && (
        <button
          className="icon-btn close"
          title={t("sidebar.close")}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            requestClose();
            e.currentTarget.closest<HTMLElement>(".session-item")?.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
});
