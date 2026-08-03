// 應用層 UI 狀態（面板開關）。
import { create } from "zustand";
import type { ChangedFile } from "../agents/extract";

/** Which changed file the diff viewer is showing. */
export interface DiffTarget extends ChangedFile {
  sessionId: string;
}

export type SidebarPendingAction =
  | { kind: "close-session"; id: string }
  | { kind: "delete-workspace"; id: string };

interface UiState {
  filesOpen: boolean;
  /** Diff overlay target; null when closed. Deliberately independent of
   *  filesOpen — closing the list must not throw away the diff. */
  diffTarget: DiffTarget | null;
  notificationsOpen: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  // 隱藏左側 session 側欄（釋放終端寬度）；預設顯示（false）。
  sidebarHidden: boolean;
  // 收合審批面板為窄 bar（避免蓋住終端機底部輸入）；預設展開（false）。
  // in-memory 且刻意持續：面板因 pending 清空而 unmount 後旗標仍保留，
  // 下次 pending 回來沿用上次選擇，才不會每次新問題又彈開擋住文字。
  approvalCollapsed: boolean;
  // 剛用工具列「新增 Workspace」建立、待側欄立即進入命名的 workspace id。
  renamingWorkspaceId: string | null;
  // 側欄正在改名的 session id。與上者互斥：同時開兩個編輯框沒有意義。
  renamingSessionId: string | null;
  /** Destructive sidebar action awaiting inline Enter/Escape confirmation. */
  sidebarPendingAction: SidebarPendingAction | null;
  /** Session whose pane is showing the find bar; null when no pane is searching.
   *  Per-pane rather than global: the bar searches only its own terminal. */
  searchSessionId: string | null;
  toggleFiles: () => void;
  setFilesOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarHidden: (v: boolean) => void;
  toggleApprovalCollapsed: () => void;
  toggleNotifications: () => void;
  setNotificationsOpen: (v: boolean) => void;
  setPaletteOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setShortcutsOpen: (v: boolean) => void;
  setRenamingWorkspaceId: (id: string | null) => void;
  setRenamingSessionId: (id: string | null) => void;
  setSidebarPendingAction: (action: SidebarPendingAction | null) => void;
  setSearchSessionId: (id: string | null) => void;
  openDiff: (target: DiffTarget) => void;
  closeDiff: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  filesOpen: false,
  diffTarget: null,
  notificationsOpen: false,
  paletteOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  sidebarHidden: false,
  approvalCollapsed: false,
  renamingWorkspaceId: null,
  renamingSessionId: null,
  sidebarPendingAction: null,
  searchSessionId: null,
  toggleFiles: () => set({ filesOpen: !get().filesOpen }),
  setFilesOpen: (v) => set({ filesOpen: v }),
  toggleSidebar: () => set({ sidebarHidden: !get().sidebarHidden }),
  setSidebarHidden: (v) => set({ sidebarHidden: v }),
  toggleApprovalCollapsed: () => set({ approvalCollapsed: !get().approvalCollapsed }),
  toggleNotifications: () => set({ notificationsOpen: !get().notificationsOpen }),
  setNotificationsOpen: (v) => set({ notificationsOpen: v }),
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  // 兩個改名旗標互斥：開一個就關掉另一個。
  setRenamingWorkspaceId: (id) => set({ renamingWorkspaceId: id, renamingSessionId: null }),
  setRenamingSessionId: (id) => set({ renamingSessionId: id, renamingWorkspaceId: null }),
  setSidebarPendingAction: (action) => set({ sidebarPendingAction: action }),
  setSearchSessionId: (id) => set({ searchSessionId: id }),
  openDiff: (target) => set({ diffTarget: target }),
  closeDiff: () => set({ diffTarget: null }),
}));
