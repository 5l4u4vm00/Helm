// Impure command helpers bridging the stores, PTY, and DOM focus.
// Shared by the command registry and components so buttons and hotkeys
// go through the exact same code path.
import { useSessionStore } from "../store/sessions";
import { clearNotifyDedupe } from "../store/notificationRouter";
import { markApprovalAnswered } from "../store/approvalSuppress";
import { groupTreeOf, useLayoutStore } from "../store/layout";
import { useWorkspaceStore, expandWorkspace } from "../store/workspaces";
import {
  DEFAULT_WORKSPACE_ID,
  clusterBySplitGroup,
  flattenGroupedIds,
  groupSessions,
  pendingApprovalsInWorkspace,
  resolveFocusedWorkspace,
  sessionsInWorkspace,
} from "../store/workspaceGroups";
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
import type { AgentLauncher } from "../agents/types";

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
  requestAnimationFrame(() => focusActiveTerminal());
}

/** A workspace's default folder (new sessions start here), or undefined when unset. */
function folderForWorkspace(id: string): string | undefined {
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.folder || undefined;
}

/** Create an ungrouped session (optionally from a launcher) and focus its terminal. */
export function newSession(launcher?: AgentLauncher, workspaceId?: string): void {
  const store = useSessionStore.getState();
  const targetWs = workspaceId ?? resolveFocusedWorkspace(store.sessions, store.activeId);
  store.createSession(launcher, targetWs, folderForWorkspace(targetWs));
  // A new session must be visible, and the collapse state now survives a
  // restart — so bootstrap can land in a workspace the user left collapsed.
  expandWorkspace(targetWs);
  requestAnimationFrame(() => focusActiveTerminal());
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

/** Split the active pane, creating a new session in the active session's group. */
export function splitActivePane(dir: SplitDir, launcher?: AgentLauncher): void {
  const store = useSessionStore.getState();
  const active = store.sessions.find((s) => s.id === store.activeId);
  if (!active) return;
  const layout = useLayoutStore.getState();
  if (!layout.canSplitPane(active.id, dir)) return;
  const newId = store.createSession(launcher, active.workspaceId, folderForWorkspace(active.workspaceId));
  layout.splitPane(active.id, dir, newId);
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
 * 這個 session 有沒有可接續的 agent 對話。衍生而非儲存：條件是「有 agent、目前
 * 沒在跑、且 profile 加上記下來的 agent session id 能組出一條指令」。
 * 實作歸屬：W-06 feat/agent-resume。
 */
export function canResumeActiveAgent(): boolean {
  return false; // W-06
}

/**
 * 把 resume 指令寫進**現有** PTY（沿用 respondActiveApproval 的 ptyWrite 慣例）。
 * 刻意不改活著的 session 的 launchCommand —— 它在 Terminal 主 effect 的 deps 裡，
 * 改它等於 teardown + ptyKill + 重開一條 PTY。
 * 實作歸屬：W-06 feat/agent-resume。
 */
export function resumeActiveAgent(): void {
  // W-06
}

/** screen-style C-a a / C-a C-a: write a literal Ctrl+A (0x01) to the active PTY. */
export function sendPrefixLiteral(): void {
  const { activeId } = useSessionStore.getState();
  if (activeId) void ptyWrite(activeId, "\x01");
}
