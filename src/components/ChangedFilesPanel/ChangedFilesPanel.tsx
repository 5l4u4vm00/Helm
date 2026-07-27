// 檔案變更面板：列出聚焦 workspace 內所有 session 動到的檔案，依 session 分組。
// 點分組標頭可跳到該 session；Esc（面板內有焦點時）關閉並把焦點還給終端機。
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { activateSession } from "../../commands/actions";
import { useSessionStore, type Session } from "../../store/sessions";
import { useUiStore } from "../../store/ui";
import {
  resolveFocusedWorkspace,
  sessionsInWorkspace,
  workspaceChangedFileCount,
} from "../../store/workspaceGroups";
import { focusActiveTerminal, handleDismissKey } from "../../focus/focusUtils";
import { handleListKey, hasNonShiftModifier } from "../../focus/listNav";
import type { ChangedFile } from "../../agents/extract";
import { useT } from "../../i18n";
import "./ChangedFilesPanel.css";

// Memoized: session refs are stable for untouched sessions, so streaming file
// changes in one session re-render only that group.
const SessionFileGroup = memo(function SessionFileGroup({ session }: { session: Session }) {
  const t = useT();
  const files = session.changedFiles ?? [];

  const onRowKey = (e: React.KeyboardEvent, file: ChangedFile) => {
    if (hasNonShiftModifier(e)) return; // region layer: bare keys only
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      useUiStore.getState().openDiff({ ...file, sessionId: session.id });
    } else if (
      handleListKey(e.key, e.currentTarget.closest(".files-list"), ".file-row")
    ) {
      e.preventDefault();
    }
  };

  return (
    <div className="files-group">
      <div
        className="files-group-header"
        role="button"
        tabIndex={-1}
        title={session.title}
        onClick={() => activateSession(session.id)}
      >
        <span className="files-group-title">{session.title}</span>
        <span className="files-group-count">{files.length}</span>
      </div>
      {files.map((f) => (
        <div
          className="file-row"
          key={`${session.id}:${f.path}`}
          role="button"
          tabIndex={0}
          title={t("files.openDiff", { path: f.path })}
          // getState(): no subscription and no new prop, so this component's
          // memo keeps comparing only `session`.
          onClick={() => useUiStore.getState().openDiff({ ...f, sessionId: session.id })}
          onKeyDown={(e) => onRowKey(e, f)}
        >
          <span className={`file-op op-${f.op.toLowerCase()}`}>{f.op}</span>
          <span className="file-path">{f.path}</span>
        </div>
      ))}
    </div>
  );
});

// Gate component: while the panel is closed only the filesOpen flag is
// subscribed, so session store ticks don't re-render anything here.
export function ChangedFilesPanel() {
  const open = useUiStore((s) => s.filesOpen);
  if (!open) return null;
  return <ChangedFilesPanelContent />;
}

function ChangedFilesPanelContent() {
  const t = useT();
  const setFilesOpen = useUiStore((s) => s.setFilesOpen);
  // 窄訂閱：session 物件引用穩定 + shallow 比對，其他 session 的 usage tick
  // 不會重繪面板；total 是 primitive，值沒變就不重繪。
  const groups = useSessionStore(
    useShallow((s) =>
      sessionsInWorkspace(s.sessions, resolveFocusedWorkspace(s.sessions, s.activeId)).filter(
        (x) => (x.changedFiles?.length ?? 0) > 0,
      ),
    ),
  );
  const total = useSessionStore((s) =>
    workspaceChangedFileCount(s.sessions, resolveFocusedWorkspace(s.sessions, s.activeId)),
  );

  const onClose = () => setFilesOpen(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    handleDismissKey(e, () => {
      onClose();
      focusActiveTerminal();
    });
  };

  return (
    <div className="files-panel" data-focus-region="files" onKeyDown={onKeyDown}>
      <div className="files-header">
        <span>{total > 0 ? t("files.titleWithCount", { count: total }) : t("files.title")}</span>
        <button className="files-close" onClick={onClose} title={t("files.close")}>
          ×
        </button>
      </div>
      <div className="files-list">
        {groups.length === 0 && <div className="files-empty">{t("files.empty")}</div>}
        {groups.map((s) => (
          <SessionFileGroup key={s.id} session={s} />
        ))}
      </div>
    </div>
  );
}
