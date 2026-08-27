// Workspace list state, persisted to localStorage (names, folders, and
// collapse state survive a restart; sessions and the split layout do not).
// Cross-store orchestration (e.g. moving sessions on delete) lives in
// src/commands/actions.ts to keep stores free of circular imports.
import { create } from "zustand";
import {
  DEFAULT_WORKSPACE_ID,
  nextWorkspaceName,
  normalizeRecipe,
  normalizeWorkspaces,
  type Workspace,
  type WorkspaceRecipe,
} from "./workspaceGroups";
import { moveWorkspaceOrder } from "./sidebarDrag";

interface WorkspaceState {
  workspaces: Workspace[];
  /** Create "Workspace N" and return its id. */
  createWorkspace: () => string;
  renameWorkspace: (id: string, name: string) => void;
  /** Set (or clear) the default working directory for new sessions in this workspace. */
  setWorkspaceFolder: (id: string, folder: string | undefined) => void;
  /** Set (or clear) the startup env/command for new sessions in this workspace.
   *  Normalized on the way in, so a reserved or malformed env key never lands
   *  in the store at all — the UI reports it, the store simply never holds it. */
  setWorkspaceRecipe: (id: string, recipe: WorkspaceRecipe | undefined) => void;
  /** Remove the workspace itself; refuses the default one. */
  deleteWorkspace: (id: string) => void;
  /** Reorder: move `id` into the gap at `toIndex`, indexed against the current
   *  list (see moveWorkspaceOrder). Sidebar order is array order, so this is
   *  the whole feature — and it write-throughs like every other mutation. */
  moveWorkspace: (id: string, toIndex: number) => void;
  toggleCollapsed: (id: string) => void;
}

const STORAGE_KEY = "helm.workspaces";

/** Windows env blocks are case-insensitive, which changes what counts as a
 *  reserved key. Read once here rather than in the pure helpers, which stay
 *  platform-agnostic and take it as an argument (same shape as launchFolder.ts). */
const IS_WINDOWS =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Win");

function loadWorkspaces(): Workspace[] {
  try {
    return normalizeWorkspaces(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"), IS_WINDOWS);
  } catch {
    return normalizeWorkspaces(null, IS_WINDOWS);
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

  setWorkspaceRecipe: (id, recipe) =>
    set((s) => ({
      workspaces: persist(
        s.workspaces.map((w) =>
          w.id === id ? { ...w, recipe: normalizeRecipe(recipe, IS_WINDOWS) } : w,
        ),
      ),
    })),

  deleteWorkspace: (id) => {
    if (id === DEFAULT_WORKSPACE_ID) return;
    set((s) => ({ workspaces: persist(s.workspaces.filter((w) => w.id !== id)) }));
  },

  moveWorkspace: (id, toIndex) =>
    set((s) => {
      const from = s.workspaces.findIndex((w) => w.id === id);
      const next = moveWorkspaceOrder(s.workspaces, from, toIndex);
      // Identity means the move was a no-op: hand back the same array so the
      // store sees no change and nothing is written to localStorage.
      return next === s.workspaces
        ? { workspaces: s.workspaces }
        : { workspaces: persist([...next]) };
    }),

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
