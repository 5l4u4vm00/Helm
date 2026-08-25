// Pure workspace-grouping helper tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/workspace-groups.test.ts
import assert from "node:assert";
import {
  DEFAULT_WORKSPACE_ID,
  RESERVED_ENV_KEYS,
  clusterBySplitGroup,
  flattenGroupedIds,
  groupSessions,
  isReservedEnvKey,
  isValidEnvKey,
  nextWorkspaceName,
  normalizeRecipe,
  normalizeWorkspaces,
  pendingApprovalsInWorkspace,
  resolveFocusedWorkspace,
  sanitizeRecipeEnv,
  sessionsInWorkspace,
  splitRunIds,
  workspaceChangedFileCount,
  type Workspace,
} from "../src/store/workspaceGroups.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function ws(id: string, name = id): Workspace {
  return { id, name, collapsed: false };
}

function sess(
  id: string,
  workspaceId: string,
  extra: {
    pendingApproval?: string;
    pendingPrompt?: { kind: "question" | "plan"; text: string };
    changedFiles?: unknown[];
  } = {},
) {
  return { id, workspaceId, ...extra };
}

// groupSessions: bucketing, empty groups, orphan fallback
{
  const workspaces = [ws(DEFAULT_WORKSPACE_ID), ws("w2")];
  const sessions = [sess("s1", DEFAULT_WORKSPACE_ID), sess("s2", "w2"), sess("s3", "w2")];
  const groups = groupSessions(workspaces, sessions);
  check("groups follow workspace array order", groups.map((g) => g.workspace.id).join(",") === "default,w2");
  check("sessions bucketed by workspaceId", groups[1].sessions.map((s) => s.id).join(",") === "s2,s3");
  check("default group holds its own sessions", groups[0].sessions.map((s) => s.id).join(",") === "s1");

  const withOrphan = groupSessions(workspaces, [sess("sX", "gone")]);
  check("orphan workspaceId falls back to default group", withOrphan[0].sessions.map((s) => s.id).join(",") === "sX");

  const empty = groupSessions([ws(DEFAULT_WORKSPACE_ID), ws("w2")], []);
  check("empty workspaces still produce groups", empty.length === 2 && empty.every((g) => g.sessions.length === 0));
}

// groupSessions: fallback when default workspace is absent
{
  const groups = groupSessions([ws("w1")], [sess("sX", "gone")]);
  check("without default, orphan falls into first group", groups[0].sessions.map((s) => s.id).join(",") === "sX");
}

// resolveFocusedWorkspace
{
  const sessions = [sess("s1", DEFAULT_WORKSPACE_ID), sess("s2", "w2")];
  check("active session's workspace wins", resolveFocusedWorkspace(sessions, "s2") === "w2");
  check("null active → default", resolveFocusedWorkspace(sessions, null) === DEFAULT_WORKSPACE_ID);
  check("unknown active → default", resolveFocusedWorkspace(sessions, "nope") === DEFAULT_WORKSPACE_ID);
  check("no sessions → default", resolveFocusedWorkspace([], "s1") === DEFAULT_WORKSPACE_ID);
}

// sessionsInWorkspace: membership and order
{
  const sessions = [sess("s1", "w1"), sess("s2", "w2"), sess("s3", "w1")];
  check(
    "only sessions of the workspace, insertion order kept",
    sessionsInWorkspace(sessions, "w1").map((s) => s.id).join(",") === "s1,s3",
  );
  check("unknown workspace → empty array", sessionsInWorkspace(sessions, "nope").length === 0);
}

// pendingApprovalsInWorkspace: workspace + pending filter
{
  const sessions = [
    sess("s1", "w1", { pendingApproval: "Allow?" }),
    sess("s2", "w1", { pendingPrompt: { kind: "question", text: "Which option?" } }),
    sess("s3", "w2", { pendingApproval: "Run?" }),
  ];
  check(
    "only approvals in the workspace; questions stay out of the panel",
    pendingApprovalsInWorkspace(sessions, "w1").map((s) => s.id).join(",") === "s1",
  );
  check(
    "other workspace's pending excluded",
    pendingApprovalsInWorkspace(sessions, "w2").map((s) => s.id).join(",") === "s3",
  );
  check(
    "no pending → empty array",
    pendingApprovalsInWorkspace([sess("s4", "w3")], "w3").length === 0,
  );
}

// workspaceChangedFileCount: per-workspace file totals
{
  const sessions = [
    sess("s1", "w1", { changedFiles: [{}, {}] }),
    sess("s2", "w1", { changedFiles: [{}] }),
    sess("s3", "w1"),
    sess("s4", "w2", { changedFiles: [{}] }),
  ];
  check("counts files across the workspace's sessions", workspaceChangedFileCount(sessions, "w1") === 3);
  check("other workspace not mixed in", workspaceChangedFileCount(sessions, "w2") === 1);
  check("empty workspace → 0", workspaceChangedFileCount(sessions, "nope") === 0);
}

// flattenGroupedIds: visual order across groups
{
  const workspaces = [ws(DEFAULT_WORKSPACE_ID), ws("w2")];
  const sessions = [sess("s3", "w2"), sess("s1", DEFAULT_WORKSPACE_ID), sess("s2", "w2")];
  const flat = flattenGroupedIds(groupSessions(workspaces, sessions));
  check("flatten follows group order then insertion order", flat.join(",") === "s1,s3,s2");
  check("flatten empty groups → empty array", flattenGroupedIds(groupSessions(workspaces, [])).length === 0);
}

// clusterBySplitGroup: reordering + position tagging
{
  const s = (id: string) => ({ id });

  // Interleaved group members get pulled together at the first member's spot.
  {
    const sessions = [s("a"), s("b"), s("c"), s("d")];
    const groupIdOf = (id: string) => (id === "a" || id === "c" ? "g1" : null);
    const result = clusterBySplitGroup(sessions, groupIdOf);
    check(
      "interleaved group members become contiguous, stable order otherwise",
      result.map((r) => r.session.id).join(",") === "a,c,b,d",
    );
    check(
      "ungrouped sessions tagged solo",
      result.find((r) => r.session.id === "b")!.cluster.position === "solo" &&
        result.find((r) => r.session.id === "b")!.cluster.groupId === null,
    );
    check(
      "2-member cluster tagged first/last (no middle)",
      result.find((r) => r.session.id === "a")!.cluster.position === "first" &&
        result.find((r) => r.session.id === "c")!.cluster.position === "last",
    );
  }

  // 3-member cluster: first/middle/last.
  {
    const sessions = [s("x"), s("y"), s("z")];
    const groupIdOf = () => "g2";
    const result = clusterBySplitGroup(sessions, groupIdOf);
    check(
      "3-member cluster tagged first/middle/last in order",
      result.map((r) => r.cluster.position).join(",") === "first,middle,last",
    );
    check(
      "all members share the same groupId",
      result.every((r) => r.cluster.groupId === "g2"),
    );
  }

  // All ungrouped: order unchanged, all solo.
  {
    const sessions = [s("p"), s("q")];
    const result = clusterBySplitGroup(sessions, () => null);
    check(
      "no groups → original order preserved",
      result.map((r) => r.session.id).join(",") === "p,q",
    );
    check("no groups → all solo", result.every((r) => r.cluster.position === "solo"));
  }
}

// --- normalizeWorkspaces (persisted list validation) ---
{
  console.log("\nnormalizeWorkspaces:");

  for (const [label, raw] of [
    ["null", null],
    ["物件（非陣列）", { nope: 1 }],
    ["字串", "[]"],
    ["空陣列", []],
  ] as const) {
    const out = normalizeWorkspaces(raw);
    check(
      `${label} → 單一預設 workspace`,
      out.length === 1 && out[0].id === DEFAULT_WORKSPACE_ID,
    );
  }

  {
    const out = normalizeWorkspaces([{ id: "x", name: "X", collapsed: false }]);
    check(
      "缺少 default → 補在最前（否則所有 workspace 都可刪）",
      out.length === 2 && out[0].id === DEFAULT_WORKSPACE_ID && out[1].id === "x",
    );
  }

  {
    const out = normalizeWorkspaces([
      { id: DEFAULT_WORKSPACE_ID, name: "First", collapsed: false },
      { id: DEFAULT_WORKSPACE_ID, name: "Second", collapsed: true },
    ]);
    check("重複 id → 保留第一個", out.length === 1 && out[0].name === "First");
  }

  {
    const out = normalizeWorkspaces([
      { id: DEFAULT_WORKSPACE_ID, name: "Keep", collapsed: true, folder: "/tmp/a" },
      { id: "bad", name: "Bad", collapsed: "yes" },
      { id: "", name: "Empty id", collapsed: false },
      { id: "badfolder", name: "BadFolder", collapsed: false, folder: 7 },
      null,
      "nope",
    ]);
    check("壞元素被丟掉、好的兄弟存活", out.length === 1 && out[0].name === "Keep");
    check("collapsed 與 folder 能 round-trip", out[0].collapsed === true && out[0].folder === "/tmp/a");
  }

  {
    const out = normalizeWorkspaces([
      { id: DEFAULT_WORKSPACE_ID, name: "D", collapsed: false, evil: "x" },
    ]);
    check("未知欄位不被帶過去", !("evil" in out[0]));
  }

  {
    const out = normalizeWorkspaces([{ id: DEFAULT_WORKSPACE_ID, name: "D", collapsed: false }]);
    check("沒有 folder 時不生出 folder 欄位", !("folder" in out[0]));
  }
}

// --- nextWorkspaceName (derived, not a module counter) ---
{
  console.log("\nnextWorkspaceName:");
  check("空清單 → Workspace 1", nextWorkspaceName([]) === "Workspace 1");
  check("[Workspace 1] → Workspace 2", nextWorkspaceName([ws("a", "Workspace 1")]) === "Workspace 2");
  check(
    "有缺口時取最大值 +1（不重用已刪除的號碼）",
    nextWorkspaceName([ws("a", "Workspace 1"), ws("b", "Workspace 3")]) === "Workspace 4",
  );
  check(
    "全部被改過名 → 退回 length + 1",
    nextWorkspaceName([ws("a", "api"), ws("b", "web")]) === "Workspace 3",
  );
  check(
    "非十進位尾綴不算數（Workspace 2x）",
    nextWorkspaceName([ws("a", "Workspace 2x")]) === "Workspace 2",
  );
}

// --- workspace recipe: env 過濾與正規化 ---
{
  console.log("\nsanitizeRecipeEnv:");
  check("undefined 進 undefined 出", sanitizeRecipeEnv(undefined, false) === undefined);
  check("全空物件 → undefined（不留 {}）", sanitizeRecipeEnv({}, false) === undefined);
  check(
    "正常的 key/value 留下",
    JSON.stringify(sanitizeRecipeEnv({ NODE_ENV: "development" }, false)) ===
      JSON.stringify({ NODE_ENV: "development" }),
  );
  check("空字串 value 合法（等於設成空值）", sanitizeRecipeEnv({ FOO: "" }, false)?.FOO === "");
  check(
    "非字串 value 濾掉",
    sanitizeRecipeEnv({ FOO: 1 as unknown as string }, false) === undefined,
  );

  // key 形狀：擋在這裡，而不是讓它在子行程裡無聲失敗
  check("數字開頭的 key 濾掉", sanitizeRecipeEnv({ "1BAD": "x" }, false) === undefined);
  check("含空白的 key 濾掉", sanitizeRecipeEnv({ "HAS SPACE": "x" }, false) === undefined);
  check("含等號的 key 濾掉", sanitizeRecipeEnv({ "A=B": "x" }, false) === undefined);
  check("底線開頭合法", sanitizeRecipeEnv({ _OK: "x" }, false)?._OK === "x");

  // Helm 自己的變數不可被覆寫 —— 這是 hook 路由的正確性，不是偏好問題
  for (const key of RESERVED_ENV_KEYS) {
    check(`保留 key ${key} 濾掉`, sanitizeRecipeEnv({ [key]: "x" }, false) === undefined);
  }
  check(
    "Windows：小寫拼法的保留 key 也擋（環境變數不分大小寫）",
    sanitizeRecipeEnv({ helm_session_id: "x" }, true) === undefined,
  );
  check(
    "非 Windows：小寫拼法是另一個變數，放行",
    sanitizeRecipeEnv({ helm_session_id: "x" }, false)?.helm_session_id === "x",
  );
  check(
    "保留 key 只濾掉自己，同物件其他項留下",
    JSON.stringify(sanitizeRecipeEnv({ TERM: "dumb", KEEP: "1" }, false)) ===
      JSON.stringify({ KEEP: "1" }),
  );
}

{
  console.log("\nisValidEnvKey / isReservedEnvKey:");
  check("PATH 合法", isValidEnvKey("PATH"));
  check("空字串不合法", !isValidEnvKey(""));
  check("TERM 是保留字", isReservedEnvKey("TERM", false));
  check("ANTHROPIC_API_KEY 不是保留字", !isReservedEnvKey("ANTHROPIC_API_KEY", false));
}

{
  console.log("\nnormalizeRecipe:");
  check("null → undefined", normalizeRecipe(null, false) === undefined);
  check("陣列 → undefined", normalizeRecipe([], false) === undefined);
  check("空物件 → undefined", normalizeRecipe({}, false) === undefined);
  check(
    "只有空白的 command → undefined（不算設定過）",
    normalizeRecipe({ command: "   " }, false) === undefined,
  );
  check("command 保留原樣", normalizeRecipe({ command: "claude" }, false)?.command === "claude");
  check(
    "env 全被濾掉且無 command → undefined",
    normalizeRecipe({ env: { TERM: "dumb" } }, false) === undefined,
  );
  check(
    "env 全被濾掉但有 command → 不留空的 env 欄位",
    !("env" in (normalizeRecipe({ env: { TERM: "dumb" }, command: "claude" }, false) ?? {})),
  );
  const both = normalizeRecipe({ env: { A: "1" }, command: "claude" }, false);
  check("env + command 都在", both?.command === "claude" && both?.env?.A === "1");
  check(
    "env 非物件時忽略",
    normalizeRecipe({ env: "nope", command: "x" }, false)?.env === undefined,
  );
}

{
  console.log("\nnormalizeWorkspaces + recipe:");
  const out = normalizeWorkspaces(
    [{ id: DEFAULT_WORKSPACE_ID, name: "D", collapsed: false, recipe: { command: "claude" } }],
    false,
  );
  check("recipe 一起還原", out[0].recipe?.command === "claude");

  const stripped = normalizeWorkspaces(
    [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "D",
        collapsed: false,
        recipe: { env: { HELM_SESSION_ID: "hijack" } },
      },
    ],
    false,
  );
  check(
    "手改 localStorage 塞進保留 key，載入時就被濾掉",
    stripped[0].recipe === undefined && !("recipe" in stripped[0]),
  );

  const noRecipe = normalizeWorkspaces(
    [{ id: DEFAULT_WORKSPACE_ID, name: "D", collapsed: false }],
    false,
  );
  check("沒有 recipe 時不生出 recipe 欄位", !("recipe" in noRecipe[0]));

  const badRecipe = normalizeWorkspaces(
    [{ id: DEFAULT_WORKSPACE_ID, name: "D", collapsed: false, recipe: "nope" }],
    false,
  );
  check("壞掉的 recipe 不連累整個 workspace 被丟掉", badRecipe.length === 1);
}

// --- splitRunIds ----------------------------------------------------------
{
  const sessions = [
    sess("a", "w1"),
    sess("g1", "w1"),
    sess("x", "w1"),
    sess("g2", "w1"),
    sess("g3", "w1"),
  ];
  const groupIdOf = (id: string) => (id.startsWith("g") ? "G" : null);

  check("splitRunIds：沒分組的 session 是長度 1 的 run", splitRunIds(sessions, "a", groupIdOf).join(",") === "a");
  // Interleaved on purpose: the run is defined by group membership, not by
  // adjacency in the global array (clusterBySplitGroup is what makes it look
  // adjacent).
  check(
    "splitRunIds：分組成員回傳整團，且維持全域陣列順序",
    splitRunIds(sessions, "g3", groupIdOf).join(",") === "g1,g2,g3",
  );
  check(
    "splitRunIds：從任一成員問都得到同一團",
    splitRunIds(sessions, "g1", groupIdOf).join(",") === "g1,g2,g3",
  );
}

console.log(`\nworkspace-groups: ${passed} checks passed`);
