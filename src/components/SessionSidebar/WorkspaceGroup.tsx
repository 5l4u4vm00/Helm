// One collapsible workspace group: header (chevron / name / count / badge, then
// all four action buttons) plus its session rows. The actions sit on the single
// header line — they briefly lived on a second row because at 15px/6px they left
// the name a couple of characters, but shrinking them to a 20px square (see the
// row-level `.icon-btn` rule) makes all four fit and removes a whole
// show/hide mechanism. They stay hidden until the group's `.workspace-head` is
// hovered or focused, so the resting line reads as information only.
// Session rows hang off a left accent rail rather than an indent, which is what
// makes group membership visible at a glance. The whole group is a drop target so
// a session can be dragged in even when the group is collapsed, and the header
// itself is draggable so workspaces can be reordered.
//
// All drag handling lives on the group wrapper — rows deliberately have no drag
// handlers. `dragleave` is dispatched on the element being *left*, so a row
// cannot stopPropagation a dragleave whose target is the group; adding
// row-level handlers would unbalance the dragDepth counter. The hovered row is
// found from the event target instead (data-session-id).
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import type { SidebarSession } from "../../store/sidebarProjection";
import { useFolderStatusStore } from "../../store/folderStatus";
import { useWorkspaceStore } from "../../store/workspaces";
import { useUiStore } from "../../store/ui";
import type { SplitClusterInfo, Workspace } from "../../store/workspaceGroups";
import {
  activateFirstPendingApproval,
  moveWorkspaceInSidebar,
  newSession,
  newWorkspace,
  removeWorkspace,
} from "../../commands/actions";
import { focusActiveTerminal } from "../../focus/focusUtils";
import { handleListKey, hasNonShiftModifier } from "../../focus/listNav";
import { pickFolder } from "../../ipc/dialog";
import {
  displayFolderPath,
  middleEllipsis,
  sidebarCharBudget,
  workspaceNameBudget,
} from "../../store/launchFolder";
import { useSettingsStore } from "../../store/settings";
import { SessionItem, SIDEBAR_NAV_SELECTOR } from "./SessionItem";
import { useT } from "../../i18n";
import { resolveSidebarShortcut } from "./sidebarKeymap";
import { dragKind, pointerHalf, SESSION_DND_TYPE, WORKSPACE_DND_TYPE } from "./dropPosition";
import { insertIndexAt, type OrderRow } from "../../store/sidebarOrder";

type SidebarDrag =
  | { kind: "session"; index: number | null }
  | { kind: "workspace"; edge: "before" | "after" }
  | null;

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: { session: SidebarSession; cluster: SplitClusterInfo }[];
  activeId: string | null;
  listRef: React.RefObject<HTMLDivElement | null>;
  deletable: boolean;
  /** The active session's workspace: gets the lit rail and full-contrast label. */
  focused: boolean;
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
  focused,
  regionEntry,
}: WorkspaceGroupProps) {
  const t = useT();
  const toggleCollapsed = useWorkspaceStore((s) => s.toggleCollapsed);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const setWorkspaceFolder = useWorkspaceStore((s) => s.setWorkspaceFolder);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const reorderSession = useSessionStore((s) => s.reorderSession);
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
  // 側欄可調寬，所以裁切預算跟著寬度走，而不是寫死的字元數。名稱與路徑分開
  // 算：名稱那行還要分給 chevron / 計數 / 徽章 / 四顆操作鍵，預算比路徑行小。
  //
  // 路徑那行傳入實測值而非沿用預設：這一行縮排到 15px、字級降到 9.5px，量到的
  // 保留寬是 75px（預設只假設 44px）、每字元 4.56px。照預設算會在窄側欄時溢出被
  // CSS 從尾端裁掉——正好毀掉 head-clipping 要保住的結尾資料夾名。取 4.8 / 78
  // 讓預算落在實際盒寬之內，維持 sidebarCharBudget 說的保守偏誤。
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const charBudget = sidebarCharBudget(sidebarWidth, 4.8, 78);
  // One value, three meanings: a session drop line at `index` (null index =
  // drop into the group as a whole — header, padding, collapsed, or empty),
  // a workspace drop on one edge, or not a drop target at all.
  const [drag, setDrag] = useState<SidebarDrag>(null);
  // 所有 waiting 一視同仁：agentState === "waiting" 涵蓋 approval / question /
  // plan（question/plan 沒有 pendingApproval，但同樣需要使用者處理）。
  const pendingCount = useMemo(
    () => sessions.filter(({ session: s }) => s.agentState === "waiting").length,
    [sessions],
  );
  // 名稱預算要扣掉「平時就看得見」的控制項：資料夾/啟動設定鍵設定後會保持著色
  // 不隨 hover 消失，approval 徽章則是沒處理完就一直在。這幾顆會實際壓縮名稱的
  // 可用寬度，不扣就會溢出被 CSS 從尾端裁掉。
  const alwaysOnBadges =
    (w.folder && !folderMissing ? 1 : 0) + (w.recipe ? 1 : 0) + (pendingCount > 0 ? 1 : 0);
  const nameBudget = workspaceNameBudget(sidebarWidth, alwaysOnBadges);
  // The rendered rows as pure ordering data, for snapping the drop line to
  // split-cluster boundaries.
  const rows = useMemo<OrderRow[]>(
    () => sessions.map(({ session: s, cluster }) => ({ id: s.id, groupId: cluster.groupId })),
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
      else if (action === "move-up") moveGroup(e.currentTarget, -1);
      else if (action === "move-down") moveGroup(e.currentTarget, 1);
    } else if (
      !hasNonShiftModifier(e) &&
      handleListKey(e.key, listRef.current, SIDEBAR_NAV_SELECTOR)
    ) {
      e.preventDefault();
    }
  };

  // Focus rides along: React moves the keyed group node rather than recreating
  // it, so only the scroll position needs help.
  const moveGroup = (header: HTMLElement, delta: 1 | -1) => {
    moveWorkspaceInSidebar(w.id, delta);
    requestAnimationFrame(() => header.scrollIntoView({ block: "nearest" }));
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
    setDrag(null);
  };

  // dragover fires continuously; a bare setState per event would re-render the
  // group tens of times a second.
  const setDragIfChanged = (next: SidebarDrag) => {
    setDrag((cur) => {
      if (cur && next && cur.kind === next.kind) {
        if (cur.kind === "session" && next.kind === "session" && cur.index === next.index) {
          return cur;
        }
        if (cur.kind === "workspace" && next.kind === "workspace" && cur.edge === next.edge) {
          return cur;
        }
      }
      return next;
    });
  };

  const onDragOver = (e: React.DragEvent) => {
    // getData is blocked during dragover; `types` is not, so it is what gates
    // the indicator. Not preventing default for anything else means an OS file
    // drag stops showing a move cursor over the sidebar.
    const kind = dragKind(e.dataTransfer.types);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (kind === "workspace") {
      const rect = e.currentTarget.getBoundingClientRect();
      setDragIfChanged({ kind: "workspace", edge: pointerHalf(e.clientY, rect) });
      return;
    }
    const row = (e.target as HTMLElement).closest?.(".session-item") ?? null;
    const rowId = row?.getAttribute("data-session-id");
    const i = rowId ? rows.findIndex((r) => r.id === rowId) : -1;
    const index =
      i < 0 || !row
        ? null
        : insertIndexAt(rows, i, pointerHalf(e.clientY, row.getBoundingClientRect()));
    setDragIfChanged({ kind: "session", index });
  };

  const onDrop = (e: React.DragEvent) => {
    const kind = dragKind(e.dataTransfer.types);
    if (!kind) return;
    e.preventDefault();
    const pending = drag;
    clearDrag();
    if (kind === "workspace") {
      const dragId = e.dataTransfer.getData(WORKSPACE_DND_TYPE);
      const edge = pending?.kind === "workspace" ? pending.edge : "before";
      if (dragId) reorderWorkspace(dragId, w.id, edge);
      return;
    }
    const id = e.dataTransfer.getData(SESSION_DND_TYPE);
    if (!id) return;
    const index = pending?.kind === "session" ? pending.index : null;
    reorderSession(id, w.id, index === null ? null : (rows[index]?.id ?? null));
  };

  const dropIndex = drag?.kind === "session" ? drag.index : null;

  return (
    <div
      // The whole-group outline and the insertion line are mutually exclusive
      // by construction: the outline means "no row under the pointer".
      className={`workspace-group ${
        drag?.kind === "session" && drag.index === null ? "drag-over" : ""
      }`}
      data-focused={focused ? "true" : undefined}
      data-ws-drop={drag?.kind === "workspace" ? drag.edge : undefined}
      onDragEnter={(e) => {
        if (dragKind(e.dataTransfer.types)) e.preventDefault();
        dragDepth.current += 1;
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) clearDrag();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      // WebKit does not reliably fire dragleave on an Escape-cancelled drag,
      // which would leave the indicator painted.
      onDragEnd={clearDrag}
    >
      {/* The header line and its action row share one hover container: the row
          must stay up while the cursor travels onto it, yet hanging the trigger
          on the whole group popped it open for any session row too. */}
      <div className="workspace-head">
        <div
          className="workspace-header"
          role="button"
          tabIndex={-1}
          data-region-entry={regionEntry ? "true" : undefined}
          aria-expanded={!w.collapsed}
          // A draggable ancestor breaks text selection inside the input in WebKit.
          draggable={!renaming && !confirming}
          onDragStart={(e) => {
            e.dataTransfer.setData(WORKSPACE_DND_TYPE, w.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => {
            // While confirming, a click outside the ✓/✕ buttons cancels (see
            // SessionItem) rather than collapsing the group.
            if (confirming) setPendingAction(null);
            else if (!renaming) toggleCollapsed(w.id);
          }}
          // Rename starts on the second mousedown, not on dblclick: once
          // `draggable` is set WebKitGTK hands the gesture to the drag machinery
          // and dblclick never arrives (see the same note in SessionItem). The
          // button bail is needed because the header buttons stop propagation on
          // click, not on mousedown.
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            if (e.detail === 2 && e.button === 0 && !renaming && !confirming) {
              e.preventDefault();
              onRenameStart();
            }
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
            /* Middle-elided (see middleEllipsis): a workspace name identifies
               itself at both ends, so tail clipping throws away half of it.
               Full name stays in the tooltip. */
            <span className="workspace-name" title={w.name}>
              {middleEllipsis(w.name, nameBudget)}
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
            >
              {pendingCount}
            </button>
          )}
          {/* All four actions, ordered settings → create → destroy. Hidden while
              confirming or renaming so the header line owns the interaction, and
              otherwise revealed by hover/focus on `.workspace-head`. */}
          {!confirming && !renaming && (
            <span className="workspace-header-actions">
              <button
                className={`icon-btn hover-action ${w.folder && !folderMissing ? "on" : ""}`}
                title={t("sidebar.selectFolder")}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void chooseFolder();
                }}
              >
                📁
              </button>
              <button
                className={`icon-btn hover-action ${w.recipe ? "on" : ""}`}
                title={t("sidebar.editRecipe")}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  setRecipeWorkspaceId(w.id);
                }}
              >
                ⚙
              </button>
              <button
                className="icon-btn hover-action"
                title={t("sidebar.addSession")}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  addSession();
                }}
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
                    requestDelete();
                    e.currentTarget.closest<HTMLElement>(".workspace-header")?.focus();
                  }}
                >
                  ×
                </button>
              )}
            </span>
          )}
        </div>
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
          <span className="workspace-folder-path">
            {displayFolderPath(w.folder, charBudget)}
          </span>
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
          {sessions.map(({ session: s, cluster }, i) => (
            <Fragment key={s.id}>
              {dropIndex === i && <div className="sidebar-drop-line" />}
              <SessionItem
                session={s}
                clusterPos={cluster.position}
                clusterGroupId={cluster.groupId}
                isActive={s.id === activeId}
                listRef={listRef}
              />
            </Fragment>
          ))}
          {/* A trailing line makes "insert at the end" expressible. */}
          {dropIndex === sessions.length && <div className="sidebar-drop-line" />}
        </div>
      )}
    </div>
  );
});
