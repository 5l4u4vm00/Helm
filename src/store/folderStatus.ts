// Reachability of persisted workspace folders.
// Keyed by path, not workspace id, so workspaces sharing a folder share one
// probe. Probing is async and never blocks store hydration or rendering.
import { create } from "zustand";
import { dirExists } from "../ipc/paths";

interface FolderStatusState {
  /** true = probed and confirmed gone. Absent = unprobed or reachable. */
  missing: Record<string, boolean>;
  probe: (path: string) => void;
  /** Re-probe every path currently flagged missing (e.g. a volume remounted). */
  recheckMissing: () => void;
}

// In-flight paths, so a re-render storm cannot fan out duplicate invokes.
const pending = new Set<string>();

export const useFolderStatusStore = create<FolderStatusState>((set, get) => ({
  missing: {},

  probe: (path) => {
    if (!path || pending.has(path)) return;
    pending.add(path);
    void dirExists(path)
      .then((exists) => {
        set((s) => ({ missing: { ...s.missing, [path]: !exists } }));
      })
      .finally(() => pending.delete(path));
  },

  recheckMissing: () => {
    const { missing, probe } = get();
    for (const [path, gone] of Object.entries(missing)) {
      if (gone) probe(path);
    }
  },
}));
