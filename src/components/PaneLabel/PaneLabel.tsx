// pane 標題列：狀態燈、標題、agent 標籤 + 分割/關閉操作（所有窗格一律顯示）。
// 分割按鈕單擊 → 新 plain shell；launcher 選單由右鍵（contextmenu）開啟，
// 鍵盤等效為 ContextMenu 鍵或 Shift+F10。
import { memo, useEffect, useRef, useState } from "react";
import { useSessionStore, type Session } from "../../store/sessions";
import type { SplitDir } from "../../store/layoutTree";
import { splitPane } from "../../commands/actions";
import { listLaunchers } from "../../agents/registry";
import { ResumeButton } from "./ResumeButton";
import { handleListKey, hasNonShiftModifier } from "../../focus/listNav";
import { handleDismissKey } from "../../focus/focusUtils";
import type { AgentLauncher } from "../../agents/types";
import { useT } from "../../i18n";
import "./PaneLabel.css";

// 綜合狀態燈：agent 狀態優先，否則活動狀態（同 sidebar）。
function dotClass(s: Session): string {
  return s.agentState ? `agent-${s.agentState}` : s.status;
}

function isContextMenuKey(e: React.KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

// Memoized: `session` refs are stable for untouched sessions, so other
// sessions' state ticks skip this label entirely.
export const PaneLabel = memo(function PaneLabel({ session }: { session: Session }) {
  const t = useT();
  const closeSession = useSessionStore((s) => s.closeSession);
  // 記住要用哪個方向開 launcher 選單；null = 選單關閉。
  const [menuDir, setMenuDir] = useState<SplitDir | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 開啟選單的按鈕（Esc 關閉時把焦點還回去）。
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (menuDir) menuRef.current?.querySelector("button")?.focus();
  }, [menuDir]);

  const splitTo = (dir: SplitDir, launcher?: AgentLauncher) => {
    splitPane(session.id, dir, launcher);
  };

  const openMenu = (e: React.SyntheticEvent, dir: SplitDir) => {
    e.preventDefault();
    e.stopPropagation();
    triggerRef.current = e.currentTarget as HTMLElement;
    setMenuDir(dir);
  };

  const closeMenu = (refocus: boolean) => {
    setMenuDir(null);
    if (refocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (handleDismissKey(e, () => closeMenu(true))) return;
    if (hasNonShiftModifier(e)) return; // region layer: bare keys only
    if (handleListKey(e.key, menuRef.current, "button")) e.preventDefault();
  };

  const splitButton = (dir: SplitDir, icon: string, title: string) => (
    <button
      title={title}
      aria-haspopup="menu"
      aria-expanded={menuDir === dir}
      onClick={(e) => {
        e.stopPropagation();
        splitTo(dir);
      }}
      onContextMenu={(e) => openMenu(e, dir)}
      onKeyDown={(e) => {
        if (isContextMenuKey(e)) openMenu(e, dir);
      }}
    >
      {icon}
    </button>
  );

  return (
    <div className="pane-label">
      <span className={`status-dot ${dotClass(session)}`} />
      <span className="pane-title">{session.title}</span>
      {/* 誠實標示：這個 pane 的畫面是上次的記錄，shell 是新開的。放在
          .pane-actions 之外，才不會跟著 hover 才顯示。 */}
      {session.restored && (
        <span className="pane-badge" title={t("pane.restoredHint")}>
          {t("pane.restored")}
        </span>
      )}
      {session.stalled && (
        <span className="pane-badge pane-badge-warn" title={t("pane.stalled")}>
          ⏳
        </span>
      )}
      <span className="pane-actions">
        <ResumeButton session={session} />
        {splitButton("row", "◫", t("pane.splitRight"))}
        {splitButton("column", "⊟", t("pane.splitDown"))}
        <button
          className="pane-close"
          title={t("pane.close")}
          onClick={(e) => {
            e.stopPropagation();
            closeSession(session.id);
          }}
        >
          ×
        </button>
      </span>
      {menuDir && (
        <>
          <div className="menu-backdrop" onClick={() => closeMenu(false)} />
          <div
            ref={menuRef}
            className="launcher-menu pane-launcher-menu"
            role="menu"
            onKeyDown={onMenuKeyDown}
          >
            {listLaunchers().map((l) => (
              <button
                key={l.label}
                role="menuitem"
                onClick={() => {
                  splitTo(menuDir, l);
                  closeMenu(false);
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});
