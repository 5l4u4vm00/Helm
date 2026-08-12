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
  newWorkspace,
  removeWorkspace,
} from "../../commands/actions";
import { focusActiveTerminal } from "../../focus/focusUtils";
import { handleListKey, hasNonShiftModifier } from "../../focus/listNav";
import { pickFolder } from "../../ipc/dialog";
import { displayFolderPath } from "../../store/launchFolder";
import { SessionItem, SIDEBAR_NAV_SELECTOR } from "./SessionItem";
import { useT } from "../../i18n";
import { resolveSidebarShortcut } from "./sidebarKeymap";

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: { session: SidebarSession; cluster: SplitClusterInfo }[];
  activeId: string | null;
  listRef: React.RefObject<HTMLDivElement | null>;
  deletable: boolean;
  regionEntry: boolean;
}

// Memoized: rename state is subscribed from the ui store (not passed as
// per-render closures) so unrelated sidebar re-renders skip whole groups.
export const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace: w,
  sessions,
  activeId,
  listRef,
  deletable,
  regionEntry,
}: WorkspaceGroupProps) {
  const t = useT();
  const toggleCollapsed = useWorkspaceStore((s) => s.toggleCollapsed);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const setWorkspaceFolder = useWorkspaceStore((s) => s.setWorkspaceFolder);
  const moveSessionToWorkspace = useSessionStore((s) => s.moveSessionToWorkspace);
  const renaming = useUiStore((s) => s.renamingWorkspaceId === w.id);
  const setRenamingId = useUiStore((s) => s.setRenamingWorkspaceId);
  const pendingAction = useUiStore((s) => s.sidebarPendingAction);
  const setPendingAction = useUiStore((s) => s.setSidebarPendingAction);
  const setRecipeWorkspaceId = useUiStore((s) => s.setRecipeWorkspaceId);
  const onRenameStart = () => setRenamingId(w.id);
  const onRenameEnd = () => setRenamingId(null);
  const confirming = pendingAction?.kind === "delete-workspace" && pendingAction.id === w.id;
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

  const focusAfterRemoval = (index: number) => {
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLElement>(SIDEBAR_NAV_SELECTOR) ?? [];
      const next = items[Math.min(index, items.length - 1)];
      if (next) next.focus();
      else focusActiveTerminal();
    });
  };

  const requestDelete = () => {
    if (deletable) setPendingAction({ kind: "delete-workspace", id: w.id });
  };

  // `header` is the focused/clicked workspace header — used to keep roving
  // focus on the same list position after the group disappears.
  const confirmDelete = (header: HTMLElement | null) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>(SIDEBAR_NAV_SELECTOR) ?? [])];
    const index = header ? items.indexOf(header) : -1;
    setPendingAction(null);
    removeWorkspace(w.id);
    focusAfterRemoval(Math.max(index, 0));
  };

  const onHeaderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    // A pending confirmation captures the next key (see SessionItem).
    if (confirming) {
      e.preventDefault();
      if (e.key === "Enter" || e.key === " ") {
        confirmDelete(e.currentTarget);
        return;
      }
      setPendingAction(null);
      return;
    }
    const action = resolveSidebarShortcut("workspace", e);
    if (action) {
      e.preventDefault();
      if (action === "toggle-workspace") toggleCollapsed(w.id);
      else if (action === "collapse-workspace") {
        if (!w.collapsed) toggleCollapsed(w.id);
      } else if (action === "expand-or-enter-workspace") {
        if (w.collapsed) toggleCollapsed(w.id);
        else {
          e.currentTarget
            .closest(".workspace-group")
            ?.querySelector<HTMLElement>(".session-item")
            ?.focus();
        }
      } else if (action === "rename") onRenameStart();
      else if (action === "new-session") addSession();
      else if (action === "new-workspace") setRenamingId(newWorkspace());
      else if (action === "choose-folder") void chooseFolder();
      else if (action === "request-delete") requestDelete();
      else if (action === "focus-terminal") focusActiveTerminal();
    } else if (
      !hasNonShiftModifier(e) &&
      handleListKey(e.key, listRef.current, SIDEBAR_NAV_SELECTOR)
    ) {
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
        data-region-entry={regionEntry ? "true" : undefined}
        aria-expanded={!w.collapsed}
        onClick={() => {
          // While confirming, a click outside the ✓/✕ buttons cancels (see
          // SessionItem) rather than collapsing the group.
          if (confirming) setPendingAction(null);
          else if (!renaming) toggleCollapsed(w.id);
        }}
        onDoubleClick={() => {
          if (!renaming) onRenameStart();
        }}
        onKeyDown={onHeaderKeyDown}
      >
        <span className="workspace-chevron">{w.collapsed ? "▸" : "▾"}</span>
        {confirming ? (
          <>
            <span className="sidebar-inline-confirm">
              {t("sidebar.confirmDeleteWorkspace", { count: sessions.length })}
            </span>
            <button
              className="icon-btn confirm-yes"
              title={t("sidebar.confirmYes")}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                confirmDelete(e.currentTarget.closest<HTMLElement>(".workspace-header"));
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
                e.currentTarget.closest<HTMLElement>(".workspace-header")?.focus();
              }}
            >
              ✕
            </button>
          </>
        ) : renaming ? (
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
        {!confirming && <span className="workspace-count">{sessions.length}</span>}
        {/* Cross-workspace alert: pending approvals inside this group. */}
        {!confirming && pendingCount > 0 && (
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
        {!confirming && (
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
        )}
        {!confirming && (
          <button
            className={`icon-btn hover-action ${w.recipe ? "on" : ""}`}
            title={t("sidebar.editRecipe")}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              setRecipeWorkspaceId(w.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⚙
          </button>
        )}
        {!confirming && (
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
        )}
        {!confirming && deletable && (
          <button
            className="icon-btn hover-action"
            title={t("sidebar.removeWorkspace")}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              requestDelete();
              e.currentTarget.closest<HTMLElement>(".workspace-header")?.focus();
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
          {/* Head-clipped (see displayFolderPath): the folder name matters more
              than the drive it lives on. Full path stays in the title above. */}
          <span className="workspace-folder-path">{displayFolderPath(w.folder)}</span>
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
