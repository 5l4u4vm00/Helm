// 多 session 狀態管理 + agent 感知。
import { create } from "zustand";
import { groupTreeOf, useLayoutStore } from "./layout";
import { collectSessionIds, siblingFirstSession } from "./layoutTree";
import { resolveFocusedWorkspace } from "./workspaceGroups";
import {
  clearNotifyDedupe,
  detectAgentEvent,
  isBusyState,
  shouldDesktopNotify,
  type DesktopNotifyContext,
} from "./notificationRouter";
import { useNotificationsStore } from "./notifications";
import { isWaitingKind, type NotifyKind } from "./notificationCenter";
import { appendAgentSessionId } from "./agentIdentity";
import { clearApprovalSuppress } from "./approvalSuppress";
import { mergeChangedFile } from "./changedFiles";
import { clearScanState } from "./scanState";
import { clearStaleBusy } from "./staleBusy";
import { clearResumeState } from "./resumeState";
import { nextSessionTitle, resolveRename, shouldAcceptAutoTitle } from "./sessionTitle";
import { useSettingsStore } from "./settings";
import { notify } from "../ipc/notify";
import { getProfile } from "../agents/registry";
import { t } from "../i18n";
import type { ChangedFile } from "../agents/extract";
import type { AgentLauncher, AgentState, PromptKind } from "../agents/types";
import type { PlanUsage } from "../agents/hookEvents";

export type SessionStatus = "idle" | "busy" | "exited";

export interface Session {
  id: string;
  title: string;
  status: SessionStatus; // 活動燈（無 agent 時使用）
  createdAt: number;
  workspaceId: string; // 側欄分組（純視覺，不影響 PTY）
  cwd?: string; // PTY 啟動目錄（建立時由 workspace 資料夾快照，之後不變）
  // 使用者明確改過名：此後 OSC 0/2 標題不再覆寫 title（見 sessionTitle.ts）。
  titleLocked?: boolean;
  // ---- agent 相關 ----
  agentId: string | null; // profile id（launcher 指定或被動偵測到）
  agentLabel?: string;
  agentState?: AgentState;
  pendingApproval?: string; // waiting（kind = approval）時的提示行，進 ApprovalPanel
  // waiting 且 kind 為 question/plan 時的提示：question 進 ApprovalPanel 供導覽，
  // plan 只發桌面通知（兩者都不顯示 Approve，避免隨便選中第一個選項）。
  pendingPrompt?: { kind: "question" | "plan"; text: string };
  launchCommand?: string; // 啟動時送進 PTY 的指令
  // agent CLI 自己的 session id（hook payload 的 session_id），append-only：
  // 尾端最新，只增不減（見 agentIdentity.ts 的理由）。用來組出 resume 指令。
  agentSessionIds?: string[];
  transcriptPath?: string; // hook payload 的 transcript_path；純診斷用，不 gate 任何行為
  // 這個 pane 是重啟後從快照重建的：畫面是上次的記錄，PTY 是新開的。
  // 執行期衍生旗標，刻意不寫進快照（否則資料格式等於宣告「還原＝行程已死」，
  // 未來由 daemon 接回活著的 PTY 時就得改格式）。
  restored?: boolean;
  // 停在忙碌但長時間沒有輸出。刻意不做成 AgentState —— 那會連帶波及 fleet
  // chips、狀態燈 CSS 與 sidebar.state.* 等一整排對映。
  stalled?: boolean;
  // ---- 本次執行的用量/變更（不持久化，重跑歸零）----
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  contextLeftPercent?: number;
  changedFiles?: ChangedFile[];
}

interface SessionState {
  sessions: Session[];
  activeId: string | null;
  // 方案速率限制剩餘（Claude Code Pro/Max，來自 statusline rate_limits）。
  // 帳號級、跨 session 同一份，故存全 app 最新值而非掛在個別 session 上。
  accountPlanUsage?: PlanUsage;
  createSession: (launcher?: AgentLauncher, workspaceId?: string, cwd?: string) => string;
  closeSession: (id: string) => void;
  moveSessionToWorkspace: (sessionId: string, workspaceId: string) => void;
  setActive: (id: string) => void;
  setTitle: (id: string, title: string) => void;
  /** Explicit user rename; an empty name unlocks the automatic title again. */
  renameSession: (id: string, title: string) => void;
  setStatus: (id: string, status: SessionStatus) => void;
  setDetectedAgent: (id: string, profileId: string, label: string) => void;
  setAgentState: (id: string, state: AgentState, prompt?: string, kind?: PromptKind) => void;
  clearApproval: (id: string) => void;
  /** hook payload 帶回來的 agent 身分（session_id / transcript_path）。 */
  setAgentIdentity: (
    id: string,
    identity: { agentSessionId?: string; transcriptPath?: string },
  ) => void;
  /** PTY 在 agent 工作中死掉 → interrupted 提醒（不是工作中則什麼都不做）。 */
  markInterrupted: (id: string) => void;
  /** 停滯偵測命中 → stalled 提醒（一次停滯只發一次）。 */
  markStalled: (id: string) => void;
  /** 又有輸出了 → 清掉停滯標記。 */
  clearStalled: (id: string) => void;
  /** 從快照批次還原（一次 set，不搶 activeId —— 呼叫端已算好）。 */
  restoreSessions: (input: { sessions: Session[]; activeId: string | null }) => void;
  setUsage: (
    id: string,
    usage: {
      cost?: number;
      tokensIn?: number;
      tokensOut?: number;
      contextLeftPercent?: number;
      planUsage?: PlanUsage;
    },
  ) => void;
  addChangedFile: (id: string, file: ChangedFile) => void;
}

// 比較兩個 PlanUsage 是否等值（四個子欄位皆相同），用於 setUsage 的短路檢查。
function samePlanUsage(a?: PlanUsage, b?: PlanUsage): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fiveHourLeftPercent === b.fiveHourLeftPercent &&
    a.sevenDayLeftPercent === b.sevenDayLeftPercent &&
    a.fiveHourResetsAt === b.fiveHourResetsAt &&
    a.sevenDayResetsAt === b.sevenDayResetsAt
  );
}

// 事件類型 → settings 的類型開關。查表而非三元式串接：新增 NotifyKind 時
// TS 會直接指出這張表缺一項，而串接的三元式只會默默沿用最後一個 fallback。
const NOTIFY_TOGGLE_KEYS: Record<
  NotifyKind,
  "notifyWaiting" | "notifyDone" | "notifyError" | "notifyInterrupted" | "notifyStalled"
> = {
  approval: "notifyWaiting",
  question: "notifyWaiting",
  plan: "notifyWaiting",
  done: "notifyDone",
  error: "notifyError",
  interrupted: "notifyInterrupted",
  stalled: "notifyStalled",
};

/** 桌面通知 gating 所需的環境：類型開關（settings）+ 視窗焦點 + workspace/pane 歸屬。 */
function desktopNotifyContext(sess: Session, kind: NotifyKind): DesktopNotifyContext {
  const st = useSettingsStore.getState();
  const perKind = st[NOTIFY_TOGGLE_KEYS[kind]];
  const { sessions, activeId } = useSessionStore.getState();
  // 畫面上的 pane = active 的分割群組成員；未分組時只有 active 自己
  //（與 Toolbar 的派工對象同一套定義）。
  const tree = groupTreeOf(useLayoutStore.getState().trees, activeId);
  const visibleIds = tree ? collectSessionIds(tree) : activeId ? [activeId] : [];
  return {
    enabled: st.notificationsEnabled && perKind,
    windowFocused: document.hasFocus(),
    inFocusedWorkspace: sess.workspaceId === resolveFocusedWorkspace(sessions, activeId),
    paneVisible: visibleIds.includes(sess.id),
    notifyHiddenPanes: st.notifyHiddenPanes,
  };
}

/**
 * Send the desktop notification for a session's pending prompt (approval /
 * question / plan, title differs by kind), unless the router's gate suppresses
 * it (per-kind toggle, focus/workspace suppression, dedupe cooldown — see
 * shouldDesktopNotify). Called on the entered-waiting edge and again from the
 * blur listener in App.tsx for prompts still pending. Known trade-off:
 * answering inside the terminal (not via the panel) leaves the dedupe record,
 * so an identical prompt within the cooldown shows only in the panel, without
 * a toast.
 */
export function notifyPendingPrompt(sess: Session): void {
  const kind: PromptKind = sess.pendingPrompt?.kind ?? "approval";
  const text = sess.pendingPrompt?.text ?? sess.pendingApproval;
  if (!text) return;
  if (!shouldDesktopNotify(sess.id, kind, text, desktopNotifyContext(sess, kind), Date.now())) {
    return;
  }
  notify(sess.id, t(`notify.${kind}`, { label: sess.agentLabel ?? "Agent" }), text);
}

/**
 * 狀態轉移邊緣判定出的提醒事件 → 兩個出口：通知中心（永遠記錄，重複入列
 * 由 pushNotification 去重）＋ 桌面通知（經統一 gating）。waiting 類沿用
 * notifyPendingPrompt（與 blur 補發共用同一條路徑）。
 */
function emitAgentEvent(sess: Session, kind: NotifyKind): void {
  useNotificationsStore.getState().push({
    kind,
    sessionId: sess.id,
    sessionTitle: sess.title,
    agentLabel: sess.agentLabel,
    text: sess.pendingPrompt?.text ?? sess.pendingApproval,
  });
  if (!isWaitingKind(kind)) {
    if (shouldDesktopNotify(sess.id, kind, "", desktopNotifyContext(sess, kind), Date.now())) {
      notify(sess.id, t(`notify.${kind}`, { label: sess.agentLabel ?? "Agent" }), sess.title);
    }
    return;
  }
  notifyPendingPrompt(sess);
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,

  createSession: (launcher, workspaceId, cwd) => {
    const id = crypto.randomUUID();
    const profileId = launcher?.profileId ?? null;
    const { sessions, activeId } = get();
    const session: Session = {
      id,
      // 標題編號從既有清單推導（同 nextWorkspaceName）：module counter 撐不過
      // 重啟，還原 3 個 session 之後新建的又會叫 "Session 1"。
      title: launcher?.label ?? nextSessionTitle(sessions),
      status: "idle",
      createdAt: Date.now(),
      workspaceId: workspaceId ?? resolveFocusedWorkspace(sessions, activeId),
      cwd,
      agentId: profileId,
      agentLabel: profileId ? getProfile(profileId).label : undefined,
      launchCommand: launcher?.command || undefined,
    };
    set((s) => ({ sessions: [...s.sessions, session], activeId: id }));
    return id;
  },

  closeSession: (id) => {
    const { sessions, activeId } = get();
    // 分割群組：先記下 sibling（focus 移交對象），再收合 leaf。
    const layout = useLayoutStore.getState();
    const sibling = siblingFirstSession(groupTreeOf(layout.trees, id), id);
    layout.removeSession(id);
    const remaining = sessions.filter((s) => s.id !== id);
    let nextActive = activeId;
    if (activeId === id) {
      const idx = sessions.findIndex((s) => s.id === id);
      nextActive = sibling ?? remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
    }
    set({ sessions: remaining, activeId: nextActive });
    clearNotifyDedupe(id);
    clearApprovalSuppress(id);
    clearScanState(id);
    clearStaleBusy(id);
    clearResumeState(id);
    useNotificationsStore.getState().resolveSession(id);
  },

  moveSessionToWorkspace: (sessionId, workspaceId) => {
    const { sessions } = get();
    const target = sessions.find((s) => s.id === sessionId);
    if (!target || target.workspaceId === workspaceId) return;
    // 維持「群組只含同 workspace 的 session」不變量：跨 workspace 即踢出群組。
    useLayoutStore.getState().removeSession(sessionId);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, workspaceId } : x,
      ),
    }));
  },

  setActive: (id) => set({ activeId: id }),

  // Setters below early-return when nothing would change: they run at PTY
  // output frequency (per chunk / per 150ms scan), and a no-op set() would
  // still rebuild the sessions array and re-render every subscriber.
  setTitle: (id, title) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur || !shouldAcceptAutoTitle(cur, title)) return;
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    }));
  },

  // Deliberately no identical-title short-circuit: pressing Enter on the
  // unchanged name is still a confirmation that has to flip the lock.
  renameSession: (id, title) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur) return;
    const next = resolveRename(title);
    const patch =
      next.kind === "set"
        ? { title: next.title, titleLocked: true }
        : { titleLocked: false };
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  },

  setStatus: (id, status) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur || cur.status === status || cur.status === "exited") return;
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, status } : x)),
    }));
  },

  setDetectedAgent: (id, profileId, label) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur || cur.agentId) return;
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, agentId: profileId, agentLabel: label } : x,
      ),
    }));
  },

  setAgentState: (id, state, prompt, kind = "approval") => {
    const prev = get().sessions.find((x) => x.id === id);
    if (!prev) return;
    const pendingApproval =
      state === "waiting" && kind === "approval" ? prompt : undefined;
    const pendingPrompt =
      state === "waiting" && kind !== "approval" && prompt
        ? { kind, text: prompt }
        : undefined;
    if (
      prev.agentState === state &&
      prev.pendingApproval === pendingApproval &&
      prev.pendingPrompt?.kind === pendingPrompt?.kind &&
      prev.pendingPrompt?.text === pendingPrompt?.text
    ) {
      return;
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, agentState: state, pendingApproval, pendingPrompt } : x,
      ),
    }));
    // 離開 waiting = 提示已被回答/清除 → 通知中心對應項標為 resolved。
    if (prev.agentState === "waiting" && state !== "waiting") {
      useNotificationsStore.getState().resolveSession(id);
    }
    // 狀態轉移邊緣 → 提醒事件（waiting 進入 / done / error），gating 與去重
    // 在 emitAgentEvent 內，state flapping 不會重複提醒。
    const eventKind = detectAgentEvent(prev.agentState, state, kind);
    if (eventKind) {
      const sess = get().sessions.find((x) => x.id === id);
      if (sess) emitAgentEvent(sess, eventKind);
    }
  },

  clearApproval: (id) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? { ...x, pendingApproval: undefined, pendingPrompt: undefined, agentState: undefined }
          : x,
      ),
    }));
    useNotificationsStore.getState().resolveSession(id);
  },

  // 跑在 hook 事件頻率上：id 已是最新一筆且 transcript 沒變就不動 store。
  setAgentIdentity: (id, identity) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur) return;
    const ids = appendAgentSessionId(cur.agentSessionIds, identity.agentSessionId);
    const transcriptPath = identity.transcriptPath ?? cur.transcriptPath;
    if (ids === cur.agentSessionIds && transcriptPath === cur.transcriptPath) return;
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? { ...x, agentSessionIds: ids ? [...ids] : undefined, transcriptPath }
          : x,
      ),
    }));
  },

  // PTY 死掉時只有「agent 還在工作」才算被中斷 —— 使用者自己打 exit 離開
  // shell、或 agent 早就 done 了，都不該吵。刻意不改 agentState：狀態燈由
  // onExit 的 setStatus("exited") 接手，這裡只負責發事件。
  markInterrupted: (id) => {
    const sess = get().sessions.find((x) => x.id === id);
    if (!sess || !isBusyState(sess.agentState)) return;
    emitAgentEvent(sess, "interrupted");
  },

  markStalled: (id) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur || cur.stalled) return;
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, stalled: true } : x)),
    }));
    const sess = get().sessions.find((x) => x.id === id);
    if (sess) emitAgentEvent(sess, "stalled");
  },

  clearStalled: (id) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur || !cur.stalled) return;
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, stalled: false } : x)),
    }));
  },

  // 一次置換：Terminal 的主 effect 依賴 [id, cwd, shell, launchCommand]，先建
  // session 再補 cwd 會讓它 teardown + ptyKill + 重開一次 PTY。
  restoreSessions: ({ sessions, activeId }) => {
    if (sessions.length === 0) return;
    set({ sessions, activeId: activeId ?? sessions[0].id });
  },

  setUsage: (id, usage) => {
    // statusline 每次整包送來 rate_limits，以整個物件替換即可（無須逐欄合併）。
    if (usage.planUsage && !samePlanUsage(usage.planUsage, get().accountPlanUsage)) {
      set({ accountPlanUsage: usage.planUsage });
    }
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur) return;
    const cost = usage.cost ?? cur.cost;
    const tokensIn = usage.tokensIn ?? cur.tokensIn;
    const tokensOut = usage.tokensOut ?? cur.tokensOut;
    const contextLeftPercent = usage.contextLeftPercent ?? cur.contextLeftPercent;
    if (
      cost === cur.cost &&
      tokensIn === cur.tokensIn &&
      tokensOut === cur.tokensOut &&
      contextLeftPercent === cur.contextLeftPercent
    ) {
      return;
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, cost, tokensIn, tokensOut, contextLeftPercent } : x,
      ),
    }));
  },

  addChangedFile: (id, file) => {
    const cur = get().sessions.find((x) => x.id === id);
    if (!cur) return;
    const files = cur.changedFiles ?? [];
    const next = mergeChangedFile(files, file);
    // Reference-equal means nothing changed: viewport re-scans re-report the
    // same lines constantly and must not tick the store.
    if (next === files) return;
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, changedFiles: next } : x,
      ),
    }));
  },
}));
