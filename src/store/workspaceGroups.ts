// Pure workspace-grouping helpers (no React/Zustand deps, unit-testable).
// Workspaces are ordered by array position; sessions are bucketed by their
// workspaceId, falling back to the default workspace defensively.

export const DEFAULT_WORKSPACE_ID = "default";

/**
 * Per-workspace startup recipe: the environment and first command that new
 * sessions in this workspace inherit. `folder` is the same idea and predates
 * this type, so it stays a sibling field on Workspace rather than moving in.
 *
 * Both halves are snapshotted at session-creation time, exactly like `folder`:
 * editing a recipe never reaches back into sessions that are already running.
 */
export interface WorkspaceRecipe {
  /** Extra PTY environment variables. Never overrides Helm's own (see RESERVED_ENV_KEYS). */
  env?: Record<string, string>;
  /** Written into the PTY as the session's first input line. */
  command?: string;
}

export interface Workspace {
  id: string;
  name: string;
  collapsed: boolean;
  /** Default working directory for new sessions created in this workspace. */
  folder?: string;
  /** Startup env / command for new sessions created in this workspace. */
  recipe?: WorkspaceRecipe;
}

/**
 * Environment variables a recipe may not set. The first two are how a hook
 * process finds its way back to *this* session (see hookserver.rs); letting a
 * recipe overwrite them would misroute or silently kill agent awareness, which
 * surfaces as "Helm stopped detecting my agent" and is near-undebuggable from
 * the UI. TERM is here because xterm.js is what actually decides the emulator's
 * capabilities — a mismatched TERM produces corrupted output, not a nicer one.
 */
export const RESERVED_ENV_KEYS: readonly string[] = [
  "HELM_SESSION_ID",
  "HELM_EVENT_PORT",
  "TERM",
];

/**
 * Validate one env key. POSIX allows more, but every shell agrees on this
 * subset, and a key containing `=` or whitespace cannot be exported at all —
 * the kind of entry that fails silently inside the child process rather than
 * at the point the user typed it.
 */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Whether a key is rejected because Helm owns it. Case-insensitive on Windows,
 *  whose environment block is case-insensitive — `helm_session_id` would
 *  otherwise pass here and then clobber the real one at spawn. */
export function isReservedEnvKey(key: string, windows: boolean): boolean {
  return windows
    ? RESERVED_ENV_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())
    : RESERVED_ENV_KEYS.includes(key);
}

/**
 * Drop entries a recipe must not carry: malformed keys and Helm-owned ones.
 * Applied when saving and again at spawn — a recipe can reach the spawn path
 * from localStorage that an older build (or a hand edit) wrote.
 */
export function sanitizeRecipeEnv(
  env: Record<string, string> | undefined,
  windows: boolean,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (!isValidEnvKey(key)) continue;
    if (isReservedEnvKey(key, windows)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize a recipe read back from storage. Returns undefined when empty, so
 *  an emptied recipe never persists as `{}` and read back as "configured". */
export function normalizeRecipe(raw: unknown, windows: boolean): WorkspaceRecipe | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { env, command } = raw as Record<string, unknown>;
  const cleanEnv =
    env && typeof env === "object" && !Array.isArray(env)
      ? sanitizeRecipeEnv(env as Record<string, string>, windows)
      : undefined;
  const cleanCommand = typeof command === "string" && command.trim() !== "" ? command : undefined;
  if (!cleanEnv && !cleanCommand) return undefined;
  const out: WorkspaceRecipe = {};
  if (cleanEnv) out.env = cleanEnv;
  if (cleanCommand) out.command = cleanCommand;
  return out;
}

export interface WorkspaceGroup<S extends { workspaceId: string }> {
  workspace: Workspace;
  sessions: S[];
}

function defaultWorkspace(): Workspace {
  return { id: DEFAULT_WORKSPACE_ID, name: "Workspace 1", collapsed: false };
}

/**
 * Validate a workspace list read back from storage. Rebuilds every entry
 * field by field (never spreads unknown keys through) and guarantees the
 * default workspace exists — the sidebar derives "deletable" from
 * `id !== DEFAULT_WORKSPACE_ID`, so without it every workspace could be
 * deleted and its sessions orphaned.
 */
export function normalizeWorkspaces(raw: unknown, windows = false): Workspace[] {
  if (!Array.isArray(raw)) return [defaultWorkspace()];
  const seen = new Set<string>();
  const out: Workspace[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, collapsed, folder, recipe } = item as Record<string, unknown>;
    if (typeof id !== "string" || id === "") continue;
    if (typeof name !== "string" || typeof collapsed !== "boolean") continue;
    if (folder !== undefined && typeof folder !== "string") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry: Workspace = { id, name, collapsed };
    if (folder !== undefined) entry.folder = folder;
    const cleanRecipe = normalizeRecipe(recipe, windows);
    if (cleanRecipe) entry.recipe = cleanRecipe;
    out.push(entry);
  }
  if (out.length === 0) return [defaultWorkspace()];
  if (!seen.has(DEFAULT_WORKSPACE_ID)) out.unshift(defaultWorkspace());
  return out;
}

/**
 * Name for the next "Workspace N", derived from the existing list rather than
 * a module counter: a counter neither survives a restart nor reuses numbers
 * freed by deletion.
 */
export function nextWorkspaceName(workspaces: Workspace[]): string {
  let max = 0;
  for (const w of workspaces) {
    const m = /^Workspace (\d+)$/.exec(w.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Workspace ${max > 0 ? max + 1 : workspaces.length + 1}`;
}

/** Bucket sessions under their workspace, in workspace array order. */
export function groupSessions<S extends { workspaceId: string }>(
  workspaces: Workspace[],
  sessions: S[],
): WorkspaceGroup<S>[] {
  const buckets = new Map<string, S[]>(workspaces.map((w) => [w.id, []]));
  const fallback = buckets.get(DEFAULT_WORKSPACE_ID) ?? buckets.values().next().value;
  for (const s of sessions) {
    (buckets.get(s.workspaceId) ?? fallback)?.push(s);
  }
  return workspaces.map((w) => ({ workspace: w, sessions: buckets.get(w.id) ?? [] }));
}

/**
 * Workspace that currently has focus: the active session's, else default.
 * Also where a new session lands.
 */
export function resolveFocusedWorkspace(
  sessions: { id: string; workspaceId: string }[],
  activeId: string | null,
): string {
  const active = sessions.find((s) => s.id === activeId);
  return active?.workspaceId ?? DEFAULT_WORKSPACE_ID;
}

/** Sessions belonging to one workspace, in insertion order. */
export function sessionsInWorkspace<S extends { workspaceId: string }>(
  sessions: S[],
  workspaceId: string,
): S[] {
  return sessions.filter((s) => s.workspaceId === workspaceId);
}

/** Sessions with a pending approval inside one workspace. */
export function pendingApprovalsInWorkspace<
  S extends { workspaceId: string; pendingApproval?: string },
>(sessions: S[], workspaceId: string): S[] {
  return sessions.filter((s) => s.workspaceId === workspaceId && s.pendingApproval);
}

/** Total changed-file entries across all sessions in one workspace. */
export function workspaceChangedFileCount(
  sessions: { workspaceId: string; changedFiles?: unknown[] }[],
  workspaceId: string,
): number {
  return sessionsInWorkspace(sessions, workspaceId).reduce(
    (sum, s) => sum + (s.changedFiles?.length ?? 0),
    0,
  );
}

/** Session ids in sidebar visual order (collapsed groups still included). */
export function flattenGroupedIds(
  groups: WorkspaceGroup<{ id: string; workspaceId: string }>[],
): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id));
}

/** A session's position within its split-group cluster, for connector-line rendering. */
export interface SplitClusterInfo {
  /** Split-group id the session belongs to, or null if ungrouped. */
  groupId: string | null;
  /** solo = ungrouped; first/middle/last = position within its cluster block. */
  position: "solo" | "first" | "middle" | "last";
}

/**
 * Reorder sessions so members of the same split-group tree sit contiguously
 * (stable: a group's members keep their relative order, placed at the first
 * member's position), and tag each with its cluster info for sidebar rendering.
 */
export function clusterBySplitGroup<S extends { id: string }>(
  sessions: S[],
  groupIdOf: (sessionId: string) => string | null,
): { session: S; cluster: SplitClusterInfo }[] {
  const buckets = new Map<string, S[]>();
  for (const s of sessions) {
    const groupId = groupIdOf(s.id);
    if (groupId === null) continue;
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(s);
    else buckets.set(groupId, [s]);
  }

  const placed = new Set<string>();
  const result: { session: S; cluster: SplitClusterInfo }[] = [];
  for (const s of sessions) {
    if (placed.has(s.id)) continue;
    const groupId = groupIdOf(s.id);
    if (groupId === null) {
      placed.add(s.id);
      result.push({ session: s, cluster: { groupId: null, position: "solo" } });
      continue;
    }
    const members = buckets.get(groupId)!;
    members.forEach((member, i) => {
      placed.add(member.id);
      const position = i === 0 ? "first" : i === members.length - 1 ? "last" : "middle";
      result.push({ session: member, cluster: { groupId, position } });
    });
  }
  return result;
}

/**
 * Ids of the split-cluster run containing `sessionId`, in global array order —
 * the block clusterBySplitGroup renders contiguously. Ungrouped = a run of one.
 *
 * This is the unit the sidebar reorders by: moving a single member would just
 * get pulled back beside its siblings on the next render, landing the row
 * somewhere the user never pointed at.
 */
export function splitRunIds<S extends { id: string }>(
  sessions: S[],
  sessionId: string,
  groupIdOf: (sessionId: string) => string | null,
): string[] {
  const groupId = groupIdOf(sessionId);
  if (groupId === null) return [sessionId];
  return sessions.filter((s) => groupIdOf(s.id) === groupId).map((s) => s.id);
}
