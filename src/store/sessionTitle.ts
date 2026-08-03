// Session title decisions, kept dependency-free so node can test them.
// Background: agent CLIs rewrite the OSC 0/2 terminal title constantly —
// Claude Code emits a fresh spinner title several times a second while busy —
// so a name the user typed survives only if the automatic path is blocked.
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。

/** Minimal shape `setTitle` needs; deliberately not `Session` (keeps this
 *  module free of store imports). */
interface TitleState {
  title: string;
  titleLocked?: boolean;
}

/** Should an automatic (OSC 0/2) title overwrite what the session shows?
 *  No once the user has named it explicitly, and no when nothing changes —
 *  this runs at PTY output frequency, where a no-op set() would still rebuild
 *  the sessions array and re-render every subscriber. */
export function shouldAcceptAutoTitle(cur: TitleState, next: string): boolean {
  if (cur.titleLocked) return false;
  return cur.title !== next;
}

/** Default title prefix; `Session 3` is the third free number, not the third
 *  session ever created. */
const DEFAULT_TITLE_PREFIX = "Session ";

/** Next default title, derived from the existing list rather than a module
 *  counter — the same reason `nextWorkspaceName` works that way. A counter
 *  resets on relaunch, so after restoring three sessions the next new one
 *  would collide with `Session 1`. */
export function nextSessionTitle(sessions: readonly TitleState[]): string {
  let max = 0;
  for (const s of sessions) {
    if (!s.title.startsWith(DEFAULT_TITLE_PREFIX)) continue;
    const n = Number(s.title.slice(DEFAULT_TITLE_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${DEFAULT_TITLE_PREFIX}${max + 1}`;
}

export type RenameResult = { kind: "set"; title: string } | { kind: "unlock" };

/** Interpret what the user typed into the rename box. Clearing the name is
 *  the only way back to automatic titles — it matters when a plain shell is
 *  renamed and an agent is started in it later. */
export function resolveRename(raw: string): RenameResult {
  const title = raw.trim();
  return title ? { kind: "set", title } : { kind: "unlock" };
}
