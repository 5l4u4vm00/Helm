// Workspace list state, persisted to localStorage (names, folders, and
// collapse state survive a restart; sessions and the split layout do not).
// Cross-store orchestration (e.g. moving sessions on delete) lives in
// src/commands/actions.ts to keep stores free of circular imports.
import { create } from "zustand";
import {
  DEFAULT_WORKSPACE_ID,
  nextWorkspaceName,
  normalizeWorkspaces,
  type Workspace,
} from "./workspaceGroups";

interface WorkspaceState {
  workspaces: Workspace[];
  /** Create "Workspace N" and return its id. */
  createWorkspace: () => string;
  renameWorkspace: (id: string, name: string) => void;
  /** Set (or clear) the default working directory for new sessions in this workspace. */
  setWorkspaceFolder: (id: string, folder: string | undefined) => void;
  /** Remove the workspace itself; refuses the default one. */
  deleteWorkspace: (id: string) => void;
  toggleCollapsed: (id: string) => void;
}

const STORAGE_KEY = "helm.workspaces";

function loadWorkspaces(): Workspace[] {
  try {
    return normalizeWorkspaces(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return normalizeWorkspaces(null);
  }
}

/** Write through and return the list, so each setter stays a single expression.
 *  A throwing setItem (quota, private browsing) must not abort the state
 *  change itself — losing persistence is better than losing the workspace. */
function persist(list: Workspace[]): Workspace[] {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: loadWorkspaces(),

  createWorkspace: () => {
    const id = crypto.randomUUID();
    set((s) => ({
      workspaces: persist([
        ...s.workspaces,
        { id, name: nextWorkspaceName(s.workspaces), collapsed: false },
      ]),
    }));
    return id;
  },

  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: persist(s.workspaces.map((w) => (w.id === id ? { ...w, name } : w))),
    })),

  setWorkspaceFolder: (id, folder) =>
    set((s) => ({
      workspaces: persist(s.workspaces.map((w) => (w.id === id ? { ...w, folder } : w))),
    })),

  deleteWorkspace: (id) => {
    if (id === DEFAULT_WORKSPACE_ID) return;
    set((s) => ({ workspaces: persist(s.workspaces.filter((w) => w.id !== id)) }));
  },

  toggleCollapsed: (id) =>
    set((s) => ({
      workspaces: persist(
        s.workspaces.map((w) => (w.id === id ? { ...w, collapsed: !w.collapsed } : w)),
      ),
    })),
}));

/** Expand a workspace so its sessions are visible (activation helper). */
export function expandWorkspace(id: string): void {
  const { workspaces } = useWorkspaceStore.getState();
  const target = workspaces.find((w) => w.id === id);
  if (target?.collapsed) useWorkspaceStore.getState().toggleCollapsed(id);
}
