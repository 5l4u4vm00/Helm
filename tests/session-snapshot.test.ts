// session 快照純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/session-snapshot.test.ts
import assert from "node:assert";
import {
  SNAPSHOT_VERSION,
  normalizeSnapshot,
  projectSnapshot,
  reconcileSnapshot,
  sessionsPersistEqual,
  snapshotFieldsEqual,
  type ProjectableSession,
  type SessionSnapshot,
} from "../src/store/sessionSnapshotSchema.ts";
import {
  collectSessionIds,
  leaf,
  leafCount,
  splitLeaf,
  type LayoutNode,
} from "../src/store/layoutTree.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function deep(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function sess(id: string, over: Partial<ProjectableSession> = {}): ProjectableSession {
  return {
    id,
    title: `Session ${id}`,
    status: "idle",
    createdAt: 1000,
    workspaceId: "default",
    agentId: null,
    ...over,
  };
}

/** 由 leaf session id 依序組出一棵 row split 樹（左結合）。 */
function treeOf(ids: string[]): LayoutNode {
  let root: LayoutNode = leaf(ids[0]);
  for (const id of ids.slice(1)) {
    const target = collectLeaves(root)[0];
    root = splitLeaf(root, target, "row", id);
  }
  return root;
}
function collectLeaves(root: LayoutNode): string[] {
  return root.type === "leaf"
    ? [root.id]
    : [...collectLeaves(root.a), ...collectLeaves(root.b)];
}

/** 存進磁碟再讀回來（同時驗證整份快照確實可 JSON 序列化）。 */
function roundTrip(snap: SessionSnapshot): SessionSnapshot | null {
  return normalizeSnapshot(JSON.parse(JSON.stringify(snap)));
}

// ---------------------------------------------------------------- round-trip
{
  const trees = { g1: treeOf(["s1", "s2"]) };
  const snap = projectSnapshot({
    sessions: [
      sess("s1", {
        cwd: "/repo",
        titleLocked: true,
        agentId: "claude-code",
        agentLabel: "Claude Code",
        launchCommand: "claude",
        agentSessionIds: ["a1", "a2"],
        transcriptPath: "/t.jsonl",
      }),
      sess("s2"),
    ],
    trees,
    activeId: "s2",
    savedAt: 42,
    appVersion: "0.15.1",
  });
  const back = roundTrip(snap);
  check("round-trip 完全等值", deep(back, snap));
  check("round-trip 保留 version", back?.version === SNAPSHOT_VERSION);
  check("round-trip 保留 activeId", back?.activeId === "s2");
  check(
    "round-trip 保留 agentSessionIds",
    deep(back?.sessions[0].agentSessionIds, ["a1", "a2"]),
  );
  check("round-trip 保留 titleLocked", back?.sessions[0].titleLocked === true);
  check("round-trip 保留分割樹", deep(back?.groups, snap.groups));
}

// ----------------------------------------------------- 模擬一次完整的重啟
// 存檔 → JSON → 讀回 → 收斂，佈局與歸屬都應該原封不動地重建出來。
{
  const t1 = treeOf(["s1", "s2", "s3"]);
  const t2 = treeOf(["s4", "s5"]);
  const before = projectSnapshot({
    sessions: [
      sess("s1", { workspaceId: "ws-a", cwd: "/a", agentId: "claude-code" }),
      sess("s2", { workspaceId: "ws-a", cwd: "/a" }),
      sess("s3", { workspaceId: "ws-a", cwd: "/a" }),
      sess("s4", { workspaceId: "ws-b" }),
      sess("s5", { workspaceId: "ws-b" }),
      sess("s6", { workspaceId: "ws-b" }), // 未分組
    ],
    trees: { g1: t1, g2: t2 },
    activeId: "s4",
    savedAt: 7,
  });
  const r = reconcileSnapshot(roundTrip(before)!, ["default", "ws-a", "ws-b"]);
  check("重啟：session 一筆不少", r.sessions.length === 6);
  check("重啟：id 一個都沒重新產生", deep(r.sessions.map((s) => s.id), ["s1", "s2", "s3", "s4", "s5", "s6"]));
  check("重啟：沒有任何修復記錄", r.repairs.length === 0);
  check("重啟：兩個群組都回來了", r.groups.length === 2);
  check("重啟：第一組成員與順序不變", deep(collectSessionIds(r.groups[0]), collectSessionIds(t1)));
  check("重啟：第二組成員與順序不變", deep(collectSessionIds(r.groups[1]), collectSessionIds(t2)));
  check("重啟：未分組的 s6 不在任何群組", !r.groups.some((g) => collectSessionIds(g).includes("s6")));
  check("重啟：activeId 沿用", r.activeId === "s4");
  check("重啟：cwd 保留", r.sessions[0].cwd === "/a");
  check("重啟：agent 身分保留", r.sessions[0].agentId === "claude-code");
}

// ------------------------------------------------- 丟棄非持久化欄位 / node id
{
  // 刻意用 as 塞進執行期欄位：投影是「逐欄挑選」而非 spread，所以應該一個都不留。
  const runtime = {
    ...sess("s1", { launchCommand: "claude" }),
    cost: 1.23,
    tokensIn: 100,
    tokensOut: 200,
    contextLeftPercent: 42,
    changedFiles: [{ path: "a.ts", source: "hook" }],
    agentState: "waiting",
    pendingApproval: "Bash: rm -rf /",
    pendingPrompt: { kind: "plan", text: "plan?" },
    stalled: true,
    restored: true,
  } as ProjectableSession;
  const snap = projectSnapshot({
    sessions: [runtime],
    trees: {},
    activeId: "s1",
    savedAt: 0,
  });
  const raw = JSON.parse(JSON.stringify(snap.sessions[0])) as Record<string, unknown>;
  const dropped = [
    "cost",
    "tokensIn",
    "tokensOut",
    "contextLeftPercent",
    "changedFiles",
    "agentState",
    "pendingApproval",
    "pendingPrompt",
  ];
  check(
    "非持久化欄位一個都不寫進快照",
    dropped.every((k) => !(k in raw)),
  );
  check("restored 不寫進快照", !("restored" in raw));
  check("stalled 不寫進快照", !("stalled" in raw));
  check("launchCommand 改名為 lastLaunchCommand", raw.lastLaunchCommand === "claude");
  check("快照沒有 launchCommand 欄位", !("launchCommand" in raw));
}

{
  const snap = projectSnapshot({
    sessions: [sess("s1"), sess("s2")],
    trees: { g1: treeOf(["s1", "s2"]) },
    activeId: "s1",
    savedAt: 0,
  });
  const split = JSON.parse(JSON.stringify(snap.groups[0])) as Record<string, unknown>;
  check("群組節點不含 node id", !("id" in split));
  check(
    "群組葉節點不含 node id",
    !("id" in (split.a as Record<string, unknown>)) &&
      !("id" in (split.b as Record<string, unknown>)),
  );
  check("groups 是陣列（不含 group id）", Array.isArray(snap.groups));
}

// lastLaunchCommand 的接續：還原出來的 session 沒有 launchCommand，靠 carried 表。
{
  const snap = projectSnapshot({
    sessions: [sess("s1")],
    trees: {},
    activeId: "s1",
    savedAt: 0,
    carriedLaunchCommands: { s1: "claude --resume" },
  });
  check("carriedLaunchCommands 接住上次的指令", snap.sessions[0].lastLaunchCommand === "claude --resume");
}
{
  const snap = projectSnapshot({
    sessions: [sess("s1", { launchCommand: "codex" })],
    trees: {},
    activeId: "s1",
    savedAt: 0,
    carriedLaunchCommands: { s1: "claude" },
  });
  check("現行 launchCommand 優先於 carried", snap.sessions[0].lastLaunchCommand === "codex");
}
// 但還原出來的 pane 相反：它的 launchCommand 可能是「自動接續」合成出來的接續
// 指令，若讓它勝出，每次重啟都會把原始指令再往外推一層
//（claude → claude --resume X → …），最後連 relaunch 都變成拿過期 id 去接續。
{
  const snap = projectSnapshot({
    sessions: [sess("s1", { launchCommand: "claude --resume abc", restored: true })],
    trees: {},
    activeId: "s1",
    savedAt: 0,
    carriedLaunchCommands: { s1: "claude" },
  });
  check(
    "還原的 pane：carried 優先（合成的接續指令不會取代原始指令）",
    snap.sessions[0].lastLaunchCommand === "claude",
  );
}
{
  const snap = projectSnapshot({
    sessions: [sess("s1", { launchCommand: "claude --resume abc", restored: true })],
    trees: {},
    activeId: "s1",
    savedAt: 0,
  });
  check(
    "還原的 pane 但沒有 carried（舊格式快照）→ 仍記下現值，不至於什麼都不存",
    snap.sessions[0].lastLaunchCommand === "claude --resume abc",
  );
}

// -------------------------------------------------------- 壞 JSON / 壞 root
{
  check("非物件 → null", normalizeSnapshot("nope") === null);
  check("null → null", normalizeSnapshot(null) === null);
  check("陣列 root → null", normalizeSnapshot([]) === null);
  check("空物件（無 version）→ null", normalizeSnapshot({}) === null);
  check(
    "sessions 不是陣列 → null",
    normalizeSnapshot({ version: SNAPSHOT_VERSION, sessions: "x" }) === null,
  );
  // 壞 JSON 由呼叫端 try/catch，這裡確認「解析得出來但是垃圾」也一樣被擋。
  let parsed: unknown = null;
  try {
    parsed = JSON.parse("{oops");
  } catch {
    parsed = "parse-failed";
  }
  check("壞 JSON 解析失敗（呼叫端冷啟動）", parsed === "parse-failed");
  check("解析成純量 → null", normalizeSnapshot(JSON.parse("123")) === null);
}

// ---------------------------------------------------------------- 版本不認得
{
  const good = projectSnapshot({
    sessions: [sess("s1")],
    trees: {},
    activeId: "s1",
    savedAt: 0,
  });
  check(
    "未知 version → 整份丟棄",
    normalizeSnapshot({ ...good, version: SNAPSHOT_VERSION + 1 }) === null,
  );
  check("舊 version → 整份丟棄", normalizeSnapshot({ ...good, version: 0 }) === null);
  check(
    "缺 version → 整份丟棄",
    normalizeSnapshot({ ...good, version: undefined }) === null,
  );
  check(
    "version 是字串 → 整份丟棄",
    normalizeSnapshot({ ...good, version: "1" }) === null,
  );
}

// ------------------------------------------- 不變量 #1：session 欄位 / 歸屬 / 狀態
{
  const raw = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [
      sess("s1"),
      { ...sess("s2"), title: 42 }, // 欄位型別錯
      { ...sess("s3"), agentId: undefined }, // agentId 必須是 string | null
      { id: "", title: "x", status: "idle", createdAt: 1, workspaceId: "d", agentId: null },
      "not-an-object",
      sess("s1"), // 重複 id
    ],
    groups: [],
  };
  const snap = normalizeSnapshot(raw)!;
  check("#1 壞掉的 session 丟該筆而非整批", snap.sessions.length === 1);
  check("#1 倖存的是好的那筆", snap.sessions[0].id === "s1");
}
{
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [
      { ...sess("s1", { workspaceId: "ws-deleted" }), status: "busy" },
      { ...sess("s2"), status: "exited" },
    ],
    groups: [],
  };
  const r = reconcileSnapshot(snap, ["default", "ws-2"]);
  check("#1 workspace 不存在 → 改回 default", r.sessions[0].workspaceId === "default");
  check("#1 存在的 workspace 沿用", r.sessions[1].workspaceId === "default");
  check(
    "#1 status 一律回 idle（PTY 是新的）",
    r.sessions.every((s) => s.status === "idle"),
  );
  check("#1 修復被記錄", r.repairs.some((x) => x.includes("ws-deleted")));
  check("#1 絕不丟 session", r.sessions.length === 2);
}
{
  // 同 id 的兩筆（normalize 已擋，reconcile 再擋一次，因為它也接得到手組的輸入）。
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1") as never, sess("s1") as never],
    groups: [],
  };
  const r = reconcileSnapshot(snap, ["default"]);
  check("#1 重複 session id 只留一筆", r.sessions.length === 1);
}

// --------------------------------------------- 不變量 #2：節點形狀壞 → 丟整組
{
  const ok = projectSnapshot({
    sessions: [sess("s1"), sess("s2")],
    trees: { g1: treeOf(["s1", "s2"]) },
    activeId: "s1",
    savedAt: 0,
  }).groups[0];
  const raw = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1"), sess("s2")],
    groups: [
      { type: "split", dir: "sideways", ratio: 0.5, a: { type: "leaf", sessionId: "x" }, b: { type: "leaf", sessionId: "y" } },
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf" }, b: { type: "leaf", sessionId: "y" } },
      { type: "leaf", sessionId: 7 },
      "garbage",
      ok,
    ],
  };
  const snap = normalizeSnapshot(raw)!;
  check("#2 形狀壞的群組整組丟掉，好的留下", snap.groups.length === 1);
  check("#2 留下的是好的那組", deep(snap.groups[0], ok));
}
{
  // 群組被丟掉 → 其 session 仍在清單裡，只是退回獨立全螢幕（＝現行行為）。
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1") as never, sess("s2") as never],
    groups: [],
  };
  const r = reconcileSnapshot(snap, ["default"]);
  check("#2 沒有群組時 session 全數保留", r.sessions.length === 2 && r.groups.length === 0);
}

// ----------------------------------------- 不變量 #3：leaf 指向不存在的 session
{
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1") as never, sess("s2") as never, sess("s3") as never],
    groups: [
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", sessionId: "s1" }, b: {
        type: "split", dir: "column", ratio: 0.5,
        a: { type: "leaf", sessionId: "gone" },
        b: { type: "leaf", sessionId: "s2" },
      } },
    ],
  };
  const r = reconcileSnapshot(snap, ["default"]);
  check("#3 死掉的 leaf 被移除", deep(collectSessionIds(r.groups[0]).sort(), ["s1", "s2"]));
  check("#3 sibling 晉升後群組仍存在", r.groups.length === 1 && leafCount(r.groups[0]) === 2);
  check("#3 修復被記錄", r.repairs.some((x) => x.includes("gone")));
}

// ------------------------------------------------- 不變量 #4：sessionId 重複
{
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1") as never, sess("s2") as never, sess("s3") as never, sess("s4") as never],
    groups: [
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", sessionId: "s1" }, b: { type: "leaf", sessionId: "s2" } },
      // s1 又出現一次（跨群組）→ 保留第一次出現，這組只剩 s3 + s4。
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", sessionId: "s1" }, b: {
        type: "split", dir: "row", ratio: 0.5,
        a: { type: "leaf", sessionId: "s3" },
        b: { type: "leaf", sessionId: "s4" },
      } },
    ],
  };
  const r = reconcileSnapshot(snap, ["default"]);
  check("#4 跨群組重複：第一組保留 s1", deep(collectSessionIds(r.groups[0]).sort(), ["s1", "s2"]));
  check("#4 跨群組重複：第二組移除 s1", deep(collectSessionIds(r.groups[1]).sort(), ["s3", "s4"]));
}
{
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1") as never, sess("s2") as never],
    groups: [
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", sessionId: "s1" }, b: {
        type: "split", dir: "row", ratio: 0.5,
        a: { type: "leaf", sessionId: "s1" },
        b: { type: "leaf", sessionId: "s2" },
      } },
    ],
  };
  const r = reconcileSnapshot(snap, ["default"]);
  check(
    "#4 同群組重複：s1 只剩一片 leaf",
    deep(collectSessionIds(r.groups[0]).sort(), ["s1", "s2"]),
  );
  check("#4 同群組重複被記錄", r.repairs.some((x) => x.includes("twice in one group")));
}

// ---------------------------------------- 不變量 #5：群組混到別的 workspace
{
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [
      sess("s1", { workspaceId: "ws-a" }) as never,
      sess("s2", { workspaceId: "ws-a" }) as never,
      sess("s3", { workspaceId: "ws-b" }) as never,
    ],
    groups: [
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", sessionId: "s1" }, b: {
        type: "split", dir: "row", ratio: 0.5,
        a: { type: "leaf", sessionId: "s3" },
        b: { type: "leaf", sessionId: "s2" },
      } },
    ],
  };
  const r = reconcileSnapshot(snap, ["default", "ws-a", "ws-b"]);
  check(
    "#5 以第一個存活 leaf 的 workspace 為準，移除其他",
    deep(collectSessionIds(r.groups[0]).sort(), ["s1", "s2"]),
  );
  check("#5 被踢出的 session 仍在清單裡", r.sessions.some((s) => s.id === "s3"));
  check("#5 修復被記錄", r.repairs.some((x) => x.includes("workspace ws-a")));
}

// -------------------------------------------- 不變量 #6：收合後 <2 leaf 解散
{
  const snap: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1") as never],
    groups: [
      { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", sessionId: "s1" }, b: { type: "leaf", sessionId: "gone" } },
      { type: "leaf", sessionId: "s1" },
    ],
  };
  const r = reconcileSnapshot(snap, ["default"]);
  check("#6 收合到 1 leaf → 群組解散", r.groups.length === 0);
  check("#6 倖存的 session 沒被丟掉", r.sessions.length === 1 && r.sessions[0].id === "s1");
  check("#6 解散被記錄", r.repairs.some((x) => x.includes("group dissolved")));
}

// ------------------------------------------------------ 不變量 #7：activeId
{
  const base: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s2",
    sessions: [sess("s1") as never, sess("s2") as never],
    groups: [],
  };
  check("#7 activeId 存活則沿用", reconcileSnapshot(base, ["default"]).activeId === "s2");
  const dangling = reconcileSnapshot({ ...base, activeId: "gone" }, ["default"]);
  check("#7 activeId 懸空 → 第一個 session", dangling.activeId === "s1");
  check("#7 懸空被記錄", dangling.repairs.some((x) => x.includes("activeId")));
  check(
    "#7 activeId 為 null → 第一個 session",
    reconcileSnapshot({ ...base, activeId: null }, ["default"]).activeId === "s1",
  );
  check(
    "#7 沒有 session → null",
    reconcileSnapshot({ ...base, sessions: [], activeId: "gone" }, ["default"]).activeId === null,
  );
}

// ------------------------------------------------------------- ratio 收斂
{
  const raw = {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    activeId: "s1",
    sessions: [sess("s1"), sess("s2")],
    groups: [
      { type: "split", dir: "row", ratio: Number.NaN, a: { type: "leaf", sessionId: "s1" }, b: { type: "leaf", sessionId: "s2" } },
    ],
  };
  // NaN 走不過 JSON（會變成 null），所以直接餵物件模擬手改過的檔案。
  const snap = normalizeSnapshot(raw)!;
  const r = reconcileSnapshot(snap, ["default"]);
  const root = r.groups[0];
  check("ratio 非有限值不丟群組，改由 clamp 收斂", root.type === "split" && root.ratio === 0.5);
  check(
    "ratio 超出範圍被 clamp",
    (() => {
      const s2 = normalizeSnapshot({ ...raw, groups: [{ ...raw.groups[0], ratio: 9 }] })!;
      const n = reconcileSnapshot(s2, ["default"]).groups[0];
      return n.type === "split" && n.ratio === 0.95;
    })(),
  );
}

// ------------------------------------------ snapshotFieldsEqual / persistEqual
{
  const a = sess("s1", { cwd: "/x", agentSessionIds: ["a"] });
  const b = sess("s1", { cwd: "/x", agentSessionIds: ["a"] });
  check("欄位相同 → equal", snapshotFieldsEqual(a, b));
  check("title 不同 → not equal", !snapshotFieldsEqual(a, { ...b, title: "other" }));
  check("cwd 不同 → not equal", !snapshotFieldsEqual(a, { ...b, cwd: "/y" }));
  check(
    "titleLocked undefined 與 false 等值",
    snapshotFieldsEqual({ ...a, titleLocked: undefined }, { ...b, titleLocked: false }),
  );
  check(
    "agentSessionIds 元素不同 → not equal",
    !snapshotFieldsEqual(a, { ...b, agentSessionIds: ["b"] }),
  );
  check(
    "agentSessionIds 長度不同 → not equal",
    !snapshotFieldsEqual(a, { ...b, agentSessionIds: ["a", "b"] }),
  );
  // 執行期欄位（cost / agentState / pendingApproval …）刻意不參與比較。
  const busy = { ...a, cost: 9, agentState: "waiting", pendingApproval: "rm -rf" } as ProjectableSession;
  check("執行期欄位變動不算變更", snapshotFieldsEqual(a, busy));
}
{
  const s1 = sess("s1");
  const s2 = sess("s2");
  check("同參照陣列 → equal", sessionsPersistEqual([s1, s2], [s1, s2]));
  check("長度不同 → not equal", !sessionsPersistEqual([s1], [s1, s2]));
  check(
    "只有執行期欄位變動 → equal（不排寫檔）",
    sessionsPersistEqual([s1, s2], [s1, { ...s2, cost: 3 } as ProjectableSession]),
  );
  check(
    "持久化欄位變動 → not equal",
    !sessionsPersistEqual([s1, s2], [s1, { ...s2, title: "renamed" }]),
  );
  check(
    "同長度但 id 換掉（關一個開一個）→ not equal",
    !sessionsPersistEqual([s1, s2], [s1, sess("s3")]),
  );
}

console.log(`\nsession-snapshot: ${passed} checks passed`);
