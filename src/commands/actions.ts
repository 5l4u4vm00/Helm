// Impure command helpers bridging the stores, PTY, and DOM focus.
// Shared by the command registry and components so buttons and hotkeys
// go through the exact same code path.
import { useSessionStore, type Session } from "../store/sessions";
import { clearNotifyDedupe, isBusyState } from "../store/notificationRouter";
import { markApprovalAnswered } from "../store/approvalSuppress";
import { useFolderStatusStore } from "../store/folderStatus";
import { useSettingsStore } from "../store/settings";
import {
  isResumeFailed,
  markResumeAttempt,
  reportResumeFailure,
} from "../store/resumeState";
import { resolveResumePlan, type ResumePlan } from "../agents/resume";
import { groupTreeOf, useLayoutStore } from "../store/layout";
import { useWorkspaceStore, expandWorkspace } from "../store/workspaces";
import { findWorkspaceByFolder, workspaceNameForFolder } from "../store/launchFolder";
import {
  DEFAULT_WORKSPACE_ID,
  clusterBySplitGroup,
  flattenGroupedIds,
  groupSessions,
  pendingApprovalsInWorkspace,
  resolveFocusedWorkspace,
  sessionsInWorkspace,
} from "../store/workspaceGroups";
import {
  beforeIdAt,
  neighborWorkspaceId,
  stepInsertIndex,
  type OrderRow,
} from "../store/sidebarOrder";
import { computeLayout, findTreeBySession, type LayoutNode, type SplitDir } from "../store/layoutTree";
import { fleetStateOf, nextIdInState, type FleetState } from "../store/fleet";
import { getProfile } from "../agents/registry";
import { ptyWrite } from "../ipc/pty";
import { focusActiveTerminal, focusRegion } from "../focus/focusUtils";
import { useUiStore } from "../store/ui";
import {
  nextPaneCyclic,
  nextPaneDirectional,
  resizeTarget,
  type NavDir,
} from "./paneNav";
import { t } from "../i18n";
import type { AgentLauncher, AgentProfile } from "../agents/types";

/**
 * Make a session active (same semantics as clicking it in the sidebar)
 * and hand keyboard focus to its terminal. The view follows the session:
 * its split group's layout when grouped, fullscreen otherwise.
 */
export function activateSession(id: string): void {
  const store = useSessionStore.getState();
  const target = store.sessions.find((s) => s.id === id);
  store.setActive(id);
  // Keep the newly active session visible in the sidebar.
  if (target) expandWorkspace(target.workspaceId);
  // Terminal's focused-effect does not rerun when activeId is unchanged,
  // and the DOM updates after the next render — focus explicitly, post-paint.
  requestAnimationFrame(() => {
    // Double-clicking a sidebar row activates it *and* opens the rename box, so
    // this rAF (queued by the first click) would land after React mounts the
    // input and blur-commit it. Same reasoning as renameActiveSession below:
    // the input's own autoFocus wins.
    if (useUiStore.getState().renamingSessionId) return;
    focusActiveTerminal();
  });
}

/** A workspace's default folder (new sessions start here), or undefined when unset. */
function folderForWorkspace(id: string): string | undefined {
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.folder || undefined;
}

/**
 * A workspace's startup recipe, snapshotted for a new session.
 *
 * `withCommand` splits the two halves deliberately. Env is environment: it is
 * inert until something in the session uses it, so every path that starts a
 * PTY gets it. The command is an *action* — it executes on the user's machine —
 * so it is limited to paths where the user explicitly asked for a new session.
 * Opening a folder (`helm .`, Explorer) and restoring a snapshot both start
 * sessions the user did not individually request, and silently running a
 * command there is the failure mode `lastLaunchCommand` already exists to
 * prevent (see sessionSnapshotSchema.ts).
 */
function startupForWorkspace(
  id: string,
  withCommand: boolean,
): { env?: Record<string, string>; command?: string } | undefined {
  const recipe = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.recipe;
  if (!recipe) return undefined;
  return withCommand ? { env: recipe.env, command: recipe.command } : { env: recipe.env };
}

/** Create an ungrouped session (optionally from a launcher) and focus its terminal. */
export function newSession(launcher?: AgentLauncher, workspaceId?: string): void {
  const store = useSessionStore.getState();
  const targetWs = workspaceId ?? resolveFocusedWorkspace(store.sessions, store.activeId);
  store.createSession(
    launcher,
    targetWs,
    folderForWorkspace(targetWs),
    startupForWorkspace(targetWs, true),
  );
  // A new session must be visible, and the collapse state now survives a
  // restart — so bootstrap can land in a workspace the user left collapsed.
  expandWorkspace(targetWs);
  requestAnimationFrame(() => focusActiveTerminal());
}

/**
 * Open a session for a folder Helm was launched from (`helm .`, Explorer
 * context menu, or a second launch forwarded by single-instance).
 *
 * Reuses the workspace already bound to that folder so relaunching the same
 * project keeps landing in one place; otherwise creates a workspace named
 * after the folder. Either way the session's cwd is the folder, so the shell
 * starts there — no `cd` command is written into the PTY, which would race
 * with the shell's own startup and be visible in the scrollback.
 *
 * Returns the workspace id used.
 */
export function openFolderSession(folder: string): string {
  const workspaceStore = useWorkspaceStore.getState();
  const existing = findWorkspaceByFolder(
    workspaceStore.workspaces,
    folder,
    navigator.platform.startsWith("Win"),
  );
  let targetWs = existing?.id;
  if (!targetWs) {
    targetWs = workspaceStore.createWorkspace();
    workspaceStore.renameWorkspace(targetWs, workspaceNameForFolder(folder));
    workspaceStore.setWorkspaceFolder(targetWs, folder);
  }
  // Deliberately not newSession(): that reads the folder back through
  // folderForWorkspace, which would miss a workspace created microseconds ago
  // if the store write had not settled. Pass the folder we already have.
  // Env only, no recipe command — double-clicking a folder in Explorer must not
  // execute anything (see startupForWorkspace).
  useSessionStore
    .getState()
    .createSession(undefined, targetWs, folder, startupForWorkspace(targetWs, false));
  expandWorkspace(targetWs);
  requestAnimationFrame(() => focusActiveTerminal());
  return targetWs;
}

/** Put the active session's sidebar row into rename mode (palette / Ctrl+A r). */
export function renameActiveSession(): void {
  const { sessions, activeId } = useSessionStore.getState();
  const active = sessions.find((s) => s.id === activeId);
  if (!active) return;
  const ui = useUiStore.getState();
  if (ui.sidebarHidden) ui.setSidebarHidden(false);
  expandWorkspace(active.workspaceId);
  // Deliberately NOT focusSidebar(): its requestAnimationFrame(focusRegion)
  // fires after React mounts the rename input, moves focus to the row, and the
  // input's onBlur commits and closes the rename in the same frame. The
  // input's own autoFocus is what should win here.
  ui.setRenamingSessionId(active.id);
}

/** Split a pane, creating a new session in the pane's workspace and group. */
export function splitPane(sessionId: string, dir: SplitDir, launcher?: AgentLauncher): void {
  const store = useSessionStore.getState();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const layout = useLayoutStore.getState();
  if (!layout.canSplitPane(session.id, dir)) return;
  const newId = store.createSession(
    launcher,
    session.workspaceId,
    folderForWorkspace(session.workspaceId),
  );
  layout.splitPane(session.id, dir, newId);
}

/** Split the active pane. */
export function splitActivePane(dir: SplitDir, launcher?: AgentLauncher): void {
  const { activeId } = useSessionStore.getState();
  if (activeId) splitPane(activeId, dir, launcher);
}

/** Session ids in sidebar visual order (grouped by workspace, then split-group cluster). */
function sessionIdsInSidebarOrder(): string[] {
  const { workspaces } = useWorkspaceStore.getState();
  const { sessions } = useSessionStore.getState();
  const { trees } = useLayoutStore.getState();
  const groupIdOf = (id: string) => findTreeBySession(trees, id);
  const groups = groupSessions(workspaces, sessions).map((g) => ({
    workspace: g.workspace,
    sessions: clusterBySplitGroup(g.sessions, groupIdOf).map((c) => c.session),
  }));
  return flattenGroupedIds(groups);
}

/**
 * Move the focused session one step up (-1) or down (+1) inside its workspace.
 * Clamps at the workspace edge rather than hopping into the neighbouring one:
 * a hop would run the cross-workspace path, which evicts the session from its
 * split group — too destructive for an arrow key, and with no undo.
 */
export function moveSessionInSidebar(sessionId: string, delta: 1 | -1): void {
  const { sessions, reorderSession } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const { trees } = useLayoutStore.getState();
  const groupIdOf = (id: string) => findTreeBySession(trees, id);
  const rows: OrderRow[] = clusterBySplitGroup(
    sessionsInWorkspace(sessions, session.workspaceId),
    groupIdOf,
  ).map(({ session: s, cluster }) => ({ id: s.id, groupId: cluster.groupId }));
  const i = rows.findIndex((r) => r.id === sessionId);
  if (i < 0) return;
  const at = stepInsertIndex(rows, i, delta);
  if (at === null) return;
  reorderSession(sessionId, session.workspaceId, beforeIdAt(rows, at));
}

/** Move the focused workspace one step up (-1) or down (+1); clamps at the ends. */
export function moveWorkspaceInSidebar(workspaceId: string, delta: 1 | -1): void {
  const { workspaces, reorderWorkspace } = useWorkspaceStore.getState();
  const target = neighborWorkspaceId(workspaces, workspaceId, delta);
  if (!target) return;
  reorderWorkspace(workspaceId, target, delta === -1 ? "before" : "after");
}

/** Activate the next (+1) or previous (-1) session in sidebar order. */
export function cycleSession(step: 1 | -1): void {
  const ids = sessionIdsInSidebarOrder();
  if (ids.length < 2) return;
  const { activeId } = useSessionStore.getState();
  const idx = ids.indexOf(activeId ?? "");
  activateSession(ids[(idx + step + ids.length) % ids.length]);
}

/** Activate the Nth session in sidebar order (0-based); no-op when missing. */
export function switchToSessionIndex(index: number): void {
  const id = sessionIdsInSidebarOrder()[index];
  if (id) activateSession(id);
}

/** Create a workspace, open a fresh session in it, and return the workspace id. */
export function newWorkspace(): string {
  const id = useWorkspaceStore.getState().createWorkspace();
  newSession(undefined, id);
  return id;
}

/** Delete a workspace together with every session in it (PTYs die on unmount). */
export function removeWorkspace(id: string): void {
  if (id === DEFAULT_WORKSPACE_ID) return;
  const sessionStore = useSessionStore.getState();
  for (const s of sessionStore.sessions) {
    if (s.workspaceId === id) {
      sessionStore.closeSession(s.id);
    }
  }
  useWorkspaceStore.getState().deleteWorkspace(id);
}

/** Write the profile's approve/reject key sequence to the PTY and clear the prompt. */
export function respondApproval(id: string, agentId: string | null, approve: boolean): void {
  const store = useSessionStore.getState();
  const prompt = store.sessions.find((s) => s.id === id)?.pendingApproval;
  const profile = getProfile(agentId);
  void ptyWrite(id, approve ? profile.approve : profile.reject);
  store.clearApproval(id);
  // The TUI repaints past the menu asynchronously; scans in that window still
  // see the old prompt and would resurrect the approval just answered.
  if (prompt) markApprovalAnswered(id, prompt, Date.now());
  // Explicit response resets notification dedupe: a NEW approval with the
  // exact same prompt text must notify immediately.
  clearNotifyDedupe(id);
}

/** Respond to every pending approval in the focused workspace only. */
export function respondAllApprovals(approve: boolean): void {
  const { sessions, activeId } = useSessionStore.getState();
  const workspaceId = resolveFocusedWorkspace(sessions, activeId);
  for (const s of pendingApprovalsInWorkspace(sessions, workspaceId)) {
    respondApproval(s.id, s.agentId, approve);
  }
}

/** Jump to the first waiting session (approval / question / plan) in a workspace. */
/** Toolbar fleet chip: jump to the next session in the given state (sidebar
 * order, wraps around; repeated clicks cycle through all of them). */
export function activateNextInFleetState(state: FleetState): void {
  const { sessions, activeId } = useSessionStore.getState();
  const stateOf = (id: string) =>
    fleetStateOf(sessions.find((s) => s.id === id)?.agentState);
  const next = nextIdInState(sessionIdsInSidebarOrder(), stateOf, activeId, state);
  if (next) activateSession(next);
}

export function activateFirstPendingApproval(workspaceId: string): void {
  const { sessions } = useSessionStore.getState();
  const target = sessionsInWorkspace(sessions, workspaceId).find(
    (s) => s.agentState === "waiting",
  );
  if (target) activateSession(target.id);
}

export function respondActiveApproval(approve: boolean): void {
  const { sessions, activeId } = useSessionStore.getState();
  const active = sessions.find((s) => s.id === activeId);
  if (active?.pendingApproval) {
    respondApproval(active.id, active.agentId, approve);
  }
}

/** The active session's group tree (the one the view renders); null when ungrouped. */
function activeGroupTree(): LayoutNode | null {
  const { activeId } = useSessionStore.getState();
  return groupTreeOf(useLayoutStore.getState().trees, activeId);
}

/** Jump keyboard focus into the sidebar, unhiding it first when collapsed. */
export function focusSidebar(): void {
  const ui = useUiStore.getState();
  if (ui.sidebarHidden) ui.setSidebarHidden(false);
  // Expand the active session's workspace so its row (the region entry
  // point) is rendered; otherwise focus would fall back to a header button.
  const { sessions, activeId } = useSessionStore.getState();
  const active = sessions.find((s) => s.id === activeId);
  if (active) expandWorkspace(active.workspaceId);
  // The sidebar (or its entry row) may only exist after the next render.
  requestAnimationFrame(() => focusRegion("sidebar"));
}

/**
 * Move pane focus directionally or cyclically. Moving left past the leftmost
 * pane (or when ungrouped) overflows into the sidebar, vim-tmux-navigator
 * style; other directions stay no-ops at the edge.
 */
export function focusPane(dir: NavDir | "next"): void {
  const root = activeGroupTree();
  const active = useSessionStore.getState().activeId;
  if (!root || !active) {
    if (dir === "left") focusSidebar();
    return;
  }
  const { leaves } = computeLayout(root);
  const next =
    dir === "next"
      ? nextPaneCyclic(leaves, active)
      : nextPaneDirectional(leaves, active, dir);
  if (next) activateSession(next);
  else if (dir === "left") focusSidebar();
}

/** Nudge the active pane's nearest matching split by one keyboard step. */
export function resizeActivePane(dir: NavDir): void {
  const root = activeGroupTree();
  const active = useSessionStore.getState().activeId;
  if (!root || !active) return;
  const target = resizeTarget(root, active, dir);
  if (target) {
    useLayoutStore.getState().setRatio(target.splitId, target.ratio);
  }
}

/**
 * 這個 session 現在按下「接續」會送出什麼指令；null = 沒有可接續的對話。
 * 衍生而非儲存，條件三個都要成立：
 * - 有 agent（純 shell 沒有對話可接）。
 * - agent 目前沒在跑，PTY 也還活著 —— 對忙碌中的 agent 送指令只是把文字塞進
 *   它的輸入框，對死掉的 PTY 送則什麼都不會發生。
 * - profile 加上記下來的 agent session id 能組出一條指令（resolveResumePlan）。
 */
export function resumePlanForSession(sess: Session | undefined): ResumePlan | null {
  if (!sess?.agentId || sess.status === "exited" || isBusyState(sess.agentState)) {
    return null;
  }
  return resolveResumePlan(
    getProfile(sess.agentId),
    sess.agentSessionIds,
    sess.launchCommand,
    (agentSessionId) => isResumeFailed(sess.id, agentSessionId),
  );
}

/**
 * 把 resume 指令寫進**現有** PTY（沿用 respondActiveApproval 的 ptyWrite 慣例）。
 * 刻意不改活著的 session 的 launchCommand —— 它在 Terminal 主 effect 的 deps 裡，
 * 改它等於 teardown + ptyKill + 重開一條 PTY。
 */
export function resumeSessionAgent(sessionId: string): void {
  const { sessions, activeId } = useSessionStore.getState();
  const sess = sessions.find((s) => s.id === sessionId);
  const plan = resumePlanForSession(sess);
  if (!sess || !plan) return;
  // 工作目錄不在了 → 一個字都不寫進 PTY。接續是**以目錄為 scope** 的：在錯的
  // 目錄執行等於指向錯的 repo，而 Terminal 在 cwd 消失時會退回家目錄 —— 那裡
  // 要嘛找不到對話，要嘛（更糟）接到家目錄下另一段無關的對話。
  // dirExists 是 fail-open：只有「探測過且確認不在」才阻擋，未知不擋。
  if (sess.cwd && useFolderStatusStore.getState().missing[sess.cwd] === true) {
    reportResumeFailure(sess, t("terminal.launchSkipped", { command: plan.command }), {
      sessions,
      activeId,
    });
    return;
  }
  markResumeAttempt(sess.id, plan.agentSessionId, Date.now());
  void ptyWrite(sess.id, `${plan.command}\r`);
}

/** 作用中 session 有沒有可接續的對話（命令面板 / Ctrl+A R 的 enabled）。 */
export function canResumeActiveAgent(): boolean {
  const { sessions, activeId } = useSessionStore.getState();
  return resumePlanForSession(sessions.find((s) => s.id === activeId)) !== null;
}

export function resumeActiveAgent(): void {
  const { activeId } = useSessionStore.getState();
  if (activeId) resumeSessionAgent(activeId);
}

/**
 * 還原流程要不要「一開場就自動接續」，以及該用哪個指令。回傳非 null 時，呼叫端
 * 應把它當成**新建** session 的 launchCommand（那是唯一能安全設定它的時機：
 * session 還沒有 PTY，見 resumeSessionAgent 的註解）。
 *
 * 預設關（settings.resumeAgentsOnLaunch）：一次對 8 個 pane 送 `--resume` 會燒
 * token、可能撞 rate limit，而且開機時 workspace 資料夾是否還在都還沒探測完。
 * relaunch 不算接續 —— 還原流程本來就會用 launchCommand 起一次，重複回報它只會
 * 讓呼叫端誤以為上下文接回來了。
 *
 * 由 W-06 提供、留給還原流程呼叫（本支線不碰 App.tsx / sessionSnapshot.ts）。
 */
export function resumeCommandForRestore(
  session: Pick<Session, "agentId" | "agentSessionIds" | "launchCommand">,
  profile?: AgentProfile,
): string | null {
  if (!useSettingsStore.getState().resumeAgentsOnLaunch) return null;
  const plan = resolveResumePlan(
    profile ?? getProfile(session.agentId),
    session.agentSessionIds,
    session.launchCommand,
  );
  return plan && plan.kind !== "relaunch" ? plan.command : null;
}

/** screen-style C-a a / C-a C-a: write a literal Ctrl+A (0x01) to the active PTY. */
export function sendPrefixLiteral(): void {
  const { activeId } = useSessionStore.getState();
  if (activeId) void ptyWrite(activeId, "\x01");
}
