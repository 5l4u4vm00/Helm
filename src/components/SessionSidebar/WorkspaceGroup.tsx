// One collapsible workspace group: header (chevron / name / count / actions)
// plus its session rows. The whole group is a drop target so a session can
// be dragged in even when the group is collapsed.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import type { SidebarSession } from "../../store/sidebarProjection";
import { useFolderStatusStore } from "../../store/folderStatus";
import { useWorkspaceStore } from "../../store/workspaces";
import { useUiStore } from "../../store/ui";
import type { SplitClusterInfo, Workspace } from "../../store/workspaceGroups";
import {
  activateFirstPendingApproval,
  newSession,
  removeWorkspace,
} from "../../commands/actions";
import { focusActiveTerminal } from "../../focus/focusUtils";
import { focusNearestItem, handleListKey } from "../../focus/listNav";
import { pickFolder } from "../../ipc/dialog";
import { SessionItem, SIDEBAR_NAV_SELECTOR } from "./SessionItem";
import { useT } from "../../i18n";

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: { session: SidebarSession; cluster: SplitClusterInfo }[];
  activeId: string | null;
  listRef: React.RefObject<HTMLDivElement | null>;
  deletable: boolean;
}

// Memoized: rename state is subscribed from the ui store (not passed as
// per-render closures) so unrelated sidebar re-renders skip whole groups.
export const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace: w,
  sessions,
  activeId,
  listRef,
  deletable,
}: WorkspaceGroupProps) {
  const t = useT();
  const toggleCollapsed = useWorkspaceStore((s) => s.toggleCollapsed);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const setWorkspaceFolder = useWorkspaceStore((s) => s.setWorkspaceFolder);
  const moveSessionToWorkspace = useSessionStore((s) => s.moveSessionToWorkspace);
  const renaming = useUiStore((s) => s.renamingWorkspaceId === w.id);
  const setRenamingId = useUiStore((s) => s.setRenamingWorkspaceId);
  const onRenameStart = () => setRenamingId(w.id);
  const onRenameEnd = () => setRenamingId(null);
  // A persisted folder can be gone by the next launch (unmounted volume,
  // deleted worktree); probe once per path and flag it rather than guessing.
  const probeFolder = useFolderStatusStore((s) => s.probe);
  const folderMissing = useFolderStatusStore((s) =>
    w.folder ? s.missing[w.folder] === true : false,
  );
  useEffect(() => {
    if (w.folder) probeFolder(w.folder);
  }, [w.folder, probeFolder]);
  const [dragOver, setDragOver] = useState(false);
  // 所有 waiting 一視同仁：agentState === "waiting" 涵蓋 approval / question /
  // plan（question/plan 沒有 pendingApproval，但同樣需要使用者處理）。
  const pendingCount = useMemo(
    () => sessions.filter(({ session: s }) => s.agentState === "waiting").length,
    [sessions],
  );
  // Counter to ignore dragleave noise from child elements.
  const dragDepth = useRef(0);

  const commitRename = (value: string) => {
    const name = value.trim();
    if (name) renameWorkspace(w.id, name);
    onRenameEnd();
  };

  const onHeaderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapsed(w.id);
    } else if (e.key === "h" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (!w.collapsed) toggleCollapsed(w.id);
    } else if (e.key === "l" || e.key === "ArrowRight") {
      // Tree-view expand: collapsed → open; open → dive into the first row.
      e.preventDefault();
      if (w.collapsed) {
        toggleCollapsed(w.id);
      } else {
        e.currentTarget
          .closest(".workspace-group")
          ?.querySelector<HTMLElement>(".session-item")
          ?.focus();
      }
    } else if (e.key === "F2" || e.key === "r") {
      e.preventDefault();
      onRenameStart();
    } else if (e.key === "a") {
      e.preventDefault();
      addSession();
    } else if (e.key === "f") {
      e.preventDefault();
      void chooseFolder();
    } else if (e.key === "Escape") {
      e.preventDefault();
      focusActiveTerminal();
    } else if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
      // The header itself is not a nav item; continue to the nearest session
      // row below/above it (sessions of collapsed groups aren't rendered, so
      // they are skipped naturally).
      const dir = e.key === "j" || e.key === "ArrowDown" ? 1 : -1;
      if (focusNearestItem(e.currentTarget, listRef.current, SIDEBAR_NAV_SELECTOR, dir)) {
        e.preventDefault();
      }
    } else if (handleListKey(e.key, listRef.current, SIDEBAR_NAV_SELECTOR)) {
      e.preventDefault();
    }
  };

  const onRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") commitRename(e.currentTarget.value);
    else if (e.key === "Escape") onRenameEnd();
  };

  // newSession expands the target workspace itself.
  const addSession = () => newSession(undefined, w.id);

  const chooseFolder = async () => {
    const path = await pickFolder(w.folder);
    if (path) setWorkspaceFolder(w.id, path);
  };

  const clearDrag = () => {
    dragDepth.current = 0;
    setDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    clearDrag();
    const id = e.dataTransfer.getData("text/plain");
    if (id) moveSessionToWorkspace(id, w.id);
  };

  return (
    <div
      className={`workspace-group ${dragOver ? "drag-over" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) clearDrag();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={onDrop}
    >
      <div
        className="workspace-header"
        role="button"
        tabIndex={-1}
        // A j/k stop only when it has no visible session rows (collapsed or
        // empty) — otherwise the workspace would be keyboard-unreachable.
        data-nav-stop={w.collapsed || sessions.length === 0 ? "true" : undefined}
        aria-expanded={!w.collapsed}
        onClick={() => {
          if (!renaming) toggleCollapsed(w.id);
        }}
        onDoubleClick={() => {
          if (!renaming) onRenameStart();
        }}
        onKeyDown={onHeaderKeyDown}
      >
        <span className="workspace-chevron">{w.collapsed ? "▸" : "▾"}</span>
        {renaming ? (
          <input
            className="workspace-rename-input"
            defaultValue={w.name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onRenameKeyDown}
            onBlur={(e) => commitRename(e.currentTarget.value)}
          />
        ) : (
          <span className="workspace-name" title={w.name}>
            {w.name}
          </span>
        )}
        <span className="workspace-count">{sessions.length}</span>
        {/* Cross-workspace alert: pending approvals inside this group. */}
        {pendingCount > 0 && (
          <button
            className="workspace-approval-badge"
            title={t("sidebar.pendingApprovalBadge", { count: pendingCount })}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              activateFirstPendingApproval(w.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {pendingCount}
          </button>
        )}
        <button
          className={`icon-btn hover-action ${w.folder && !folderMissing ? "on" : ""}`}
          title={t("sidebar.selectFolder")}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            void chooseFolder();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          📁
        </button>
        <button
          className="icon-btn hover-action"
          title={t("sidebar.addSession")}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            addSession();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          +
        </button>
        {deletable && (
          <button
            className="icon-btn hover-action"
            title={t("sidebar.removeWorkspace")}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              removeWorkspace(w.id);
            }}
          >
            ×
          </button>
        )}
      </div>
      {w.folder && (
        <div
          className="workspace-folder"
          data-missing={folderMissing ? "true" : undefined}
          title={folderMissing ? `${w.folder}\n${t("sidebar.folderMissing")}` : w.folder}
        >
          <span className="workspace-folder-icon">📁</span>
          <span className="workspace-folder-path">{w.folder}</span>
          <button
            className="icon-btn hover-action"
            title={t("sidebar.clearFolder")}
            tabIndex={-1}
            onClick={() => setWorkspaceFolder(w.id, undefined)}
          >
            ×
          </button>
        </div>
      )}
      {!w.collapsed && (
        <div className="workspace-sessions">
          {sessions.map(({ session: s, cluster }) => (
            <SessionItem
              key={s.id}
              session={s}
              clusterPos={cluster.position}
              clusterGroupId={cluster.groupId}
              isActive={s.id === activeId}
              listRef={listRef}
            />
          ))}
        </div>
      )}
    </div>
  );
});
