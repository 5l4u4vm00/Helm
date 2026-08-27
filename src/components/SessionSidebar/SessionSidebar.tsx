// Session 側欄看板：兩層階層 — workspace（可摺疊群組）→ session。
// 「⊞」新增 workspace（立即進入命名）；新增 session 由各 workspace 群組
// 自己的「+」launcher 負責（見 WorkspaceGroup）。session 可拖曳到其他
// workspace，workspace 本身也可以拖曳調整順序。
//
// 拖放用 pointer events 而非 HTML5 DnD：Windows 上 Tauri 的原生 drop handler
// 會把 webview 內部的拖曳事件整個吃掉，`onDrop` 永遠不觸發。完整理由見
// store/sidebarDrag.ts 檔頭；控制邏輯在 useSidebarDrag。
// Keyboard: roving focus over headers + items (arrows / Enter / Delete / F2),
// Esc back to the terminal; the launcher menu is fully arrow-navigable.
import { useCallback, useMemo, useRef } from "react";
import { useSessionStore } from "../../store/sessions";
import { projectSidebarSessions } from "../../store/sidebarProjection";
import { useWorkspaceStore } from "../../store/workspaces";
import {
  groupSessions,
  clusterBySplitGroup,
  resolveFocusedWorkspace,
  DEFAULT_WORKSPACE_ID,
} from "../../store/workspaceGroups";
import { useLayoutStore } from "../../store/layout";
import { findTreeBySession } from "../../store/layoutTree";
import { useUiStore } from "../../store/ui";
import { newWorkspace } from "../../commands/actions";
import { runCommand } from "../../commands/registry";
import { WorkspaceGroup } from "./WorkspaceGroup";
import { useSidebarDrag } from "./useSidebarDrag";
import { SidebarResizer } from "./SidebarResizer";
import { useSettingsStore } from "../../store/settings";
import { useT } from "../../i18n";
import "./SessionSidebar.css";

export function SessionSidebar() {
  const t = useT();
  // 投影 selector：usage tick 等非顯示欄位的變更回傳同一個參照，側欄零重繪。
  const sessions = useSessionStore((s) => projectSidebarSessions(s.sessions));
  const activeId = useSessionStore((s) => s.activeId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const moveWorkspace = useWorkspaceStore((s) => s.moveWorkspace);
  const moveSessionToWorkspace = useSessionStore((s) => s.moveSessionToWorkspace);
  const trees = useLayoutStore((s) => s.trees);
  const setRenamingId = useUiStore((s) => s.setRenamingWorkspaceId);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setSidebarHidden = useUiStore((s) => s.setSidebarHidden);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const listRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  const groups = useMemo(() => {
    const groupIdOf = (id: string) => findTreeBySession(trees, id);
    return groupSessions(workspaces, sessions).map((g) => ({
      workspace: g.workspace,
      sessions: clusterBySplitGroup(g.sessions, groupIdOf),
    }));
  }, [workspaces, sessions, trees]);

  // Derived, never stored (see workspaceGroups): the active session's workspace
  // is the one panels scope to, so the sidebar gives its label full contrast.
  const focusedWorkspaceId = useMemo(
    () => resolveFocusedWorkspace(sessions, activeId),
    [sessions, activeId],
  );

  // Stable callbacks: useSidebarDrag rebinds its window listeners when these
  // change, and a fresh closure per render would rebind on every state tick.
  const onDropSession = useCallback(
    (sessionId: string, workspaceId: string) => moveSessionToWorkspace(sessionId, workspaceId),
    [moveSessionToWorkspace],
  );
  const onDropWorkspace = useCallback(
    (workspaceId: string, toIndex: number) => moveWorkspace(workspaceId, toIndex),
    [moveWorkspace],
  );
  const { drag, startDrag } = useSidebarDrag(listRef, onDropSession, onDropWorkspace);

  const addWorkspace = () => {
    setRenamingId(newWorkspace());
  };

  return (
    <>
      <aside
        ref={asideRef}
        className="sidebar"
        data-focus-region="sidebar"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="sidebar-header">
          <span className="sidebar-title">SESSIONS</span>
          <div className="sidebar-actions">
            <button className="icon-btn" title={t("sidebar.newWorkspace")} onClick={addWorkspace}>
              +
            </button>
            {/* 摺疊按鈕放在側欄右緣：位置本身就說明「收起這個面板」；
                收起後由 Toolbar 的 ☰（僅隱藏時顯示）帶回。 */}
            <button
              className="icon-btn"
              title={t("sidebar.hide")}
              onClick={() => setSidebarHidden(true)}
            >
              «
            </button>
          </div>
        </div>

        {/* `data-dragging` lets CSS kill hover affordances for the whole list
            while a drag is in flight, so the only highlight on screen is the
            drop indicator. */}
        <div
          className="session-list"
          ref={listRef}
          data-dragging={drag ? drag.kind : undefined}
        >
          {groups.map((g, index) => (
            <WorkspaceGroup
              key={g.workspace.id}
              workspace={g.workspace}
              sessions={g.sessions}
              activeId={activeId}
              listRef={listRef}
              deletable={g.workspace.id !== DEFAULT_WORKSPACE_ID}
              focused={g.workspace.id === focusedWorkspaceId}
              regionEntry={!activeId && index === 0}
              startDrag={startDrag}
              draggingSessionId={drag?.kind === "session" ? drag.id : null}
              draggingWorkspaceId={drag?.kind === "workspace" ? drag.id : null}
              sessionDropTarget={
                drag?.kind === "session" && drag.target?.kind === "into"
                  ? drag.target.workspaceId
                  : null
              }
              /* Insertion line: this group shows it above itself when the gap
                 index equals its own, and the last group also owns the final
                 gap below it. */
              insertBefore={
                drag?.kind === "workspace" && drag.target?.kind === "before"
                  ? drag.target.index === index
                  : false
              }
              insertAfterLast={
                drag?.kind === "workspace" &&
                drag.target?.kind === "before" &&
                index === groups.length - 1 &&
                drag.target.index === groups.length
              }
            />
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-actions">
            <button
              className={`sidebar-help-btn ${shortcutsOpen ? "on" : ""}`}
              aria-pressed={shortcutsOpen}
              title={t("shortcut.title")}
              onClick={() => runCommand("help:shortcuts")}
            >
              ?
            </button>
            <button
              className={`settings-btn ${settingsOpen ? "on" : ""}`}
              aria-pressed={settingsOpen}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              ⚙ {t("sidebar.settings")}
            </button>
          </div>
        </div>
      </aside>
      <SidebarResizer sidebarRef={asideRef} />
    </>
  );
}
