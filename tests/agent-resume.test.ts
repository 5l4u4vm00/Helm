// 接續（resume）指令解析 / 失敗訊息比對 / 使用者 profile 正規化的純函式測試。
// 執行：node --experimental-strip-types tests/agent-resume.test.ts
import assert from "node:assert";
import {
  isResumeFailure,
  matchResumeFailure,
  normalizeResume,
  resolveResumePlan,
} from "../src/agents/resume.ts";
import { BUILTIN_PROFILES, GENERIC_PROFILE } from "../src/agents/builtins.ts";
import type { AgentProfile } from "../src/agents/types.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

const claude = BUILTIN_PROFILES.find((p) => p.id === "claude-code")!;
const codex = BUILTIN_PROFILES.find((p) => p.id === "codex")!;

// 建一個只有 byId 的 profile（沒有 latest），用來測 relaunch 落點。
function profileWith(resume: AgentProfile["resume"]): AgentProfile {
  return { ...GENERIC_PROFILE, id: "test", resume };
}

// ---- 內建 profile 的接續能力 ----
check("claude-code 有 byId / latest / failure", Boolean(
  claude.resume?.byId && claude.resume.latest && claude.resume.failure,
));
check("claude-code 的 byId 含 {id} 佔位符", claude.resume!.byId!.includes("{id}"));
check("codex 沒有 resume（不支援接續 → 無按鈕）", codex.resume === undefined);
check("generic 沒有 resume", GENERIC_PROFILE.resume === undefined);

// ---- resolveResumePlan：解析順序 ----
check(
  "沒有 profile 回 null",
  resolveResumePlan(undefined, ["a"], "claude") === null,
);
check(
  "profile 無 resume 回 null（即使有啟動指令，也不降級成 relaunch）",
  resolveResumePlan(codex, ["a"], "codex") === null,
);

const byId = resolveResumePlan(claude, ["old", "new"], "claude");
check("有 id 時走 byId", byId?.kind === "resume");
check("byId 取尾端最新的 id", byId?.command === "claude --resume new");
check("byId 回報鎖定的 agent session id", byId?.agentSessionId === "new");

const failedNew = resolveResumePlan(claude, ["old", "new"], "claude", (id) => id === "new");
check("最新的 id 失敗過 → 退到前一個", failedNew?.command === "claude --resume old");
check("退回的 plan 仍是 resume 且鎖定 old", failedNew?.agentSessionId === "old");

const allFailed = resolveResumePlan(claude, ["old", "new"], "claude", () => true);
check("所有 id 都失敗過 → 降級 latest", allFailed?.kind === "continue");
check("latest 用 --continue", allFailed?.command === "claude --continue");
check("latest 不鎖定任何 id", allFailed?.agentSessionId === null);

check(
  "完全沒有 id → 降級 latest",
  resolveResumePlan(claude, undefined, "claude")?.kind === "continue",
);
check(
  "空 id 陣列 → 降級 latest",
  resolveResumePlan(claude, [], "claude")?.kind === "continue",
);

// 只有 byId、沒有 latest 的 profile：無 id 時才落到 relaunch。
const onlyById = profileWith({ byId: "mytool --resume {id}" });
const relaunch = resolveResumePlan(onlyById, [], "  mytool --flag  ");
check("無 id 且無 latest → relaunch 原本的啟動指令", relaunch?.kind === "relaunch");
check("relaunch 指令去除前後空白", relaunch?.command === "mytool --flag");
check("relaunch 不鎖定任何 id", relaunch?.agentSessionId === null);
check(
  "無 id、無 latest、也沒有啟動指令 → null（不顯示按鈕）",
  resolveResumePlan(onlyById, [], undefined) === null,
);
check(
  "啟動指令是空白字串不算（純 shell）",
  resolveResumePlan(onlyById, [], "   ") === null,
);

// byId 缺佔位符：不能用，會靜默接到「最近一次」而不是指定那段。
const badById = profileWith({ byId: "mytool --resume", latest: "mytool --continue" });
check(
  "byId 缺 {id} → 跳過，改走 latest",
  resolveResumePlan(badById, ["a"], undefined)?.kind === "continue",
);

// 多個佔位符全部替換（樣板可能同時傳給不同旗標）。
const twoPlaceholders = profileWith({ byId: "mytool -s {id} --log {id}.log" });
check(
  "{id} 全部替換而非只有第一個",
  resolveResumePlan(twoPlaceholders, ["abc"], undefined)?.command ===
    "mytool -s abc --log abc.log",
);

// ---- 失敗訊息比對 ----
const failureScreen = [
  "$ claude --resume 9f1c",
  "No conversation found with session ID 9f1c",
  "$ ",
].join("\n");
check("命中 failure pattern", isResumeFailure(claude, failureScreen));
check(
  "回傳命中的那一行（供通知顯示實際訊息）",
  matchResumeFailure(claude, failureScreen) === "No conversation found with session ID 9f1c",
);
check("不分大小寫", isResumeFailure(claude, "no conversation FOUND"));
check(
  "一般輸出不命中",
  !isResumeFailure(claude, "⏺ Read(src/App.tsx)\n  Read 40 lines"),
);
check("無 resume 的 profile 永不命中", !isResumeFailure(codex, failureScreen));
check("無 profile 永不命中", !isResumeFailure(undefined, failureScreen));
check(
  "跳過 ANSI 控制碼後仍命中",
  isResumeFailure(claude, "\x1b[31mNo conversation found\x1b[0m"),
);
check(
  "pattern 的 \\s 不跨行（逐行比對）",
  !isResumeFailure(profileWith({ latest: "x", failure: "No\\sconversation" }), "No\nconversation"),
);
check(
  "無效 regex 不丟例外、永不命中",
  !isResumeFailure(profileWith({ latest: "x", failure: "([unclosed" }), "anything"),
);

// ---- normalizeResume：使用者 agents.json ----
check("非物件回 undefined", normalizeResume("claude --resume") === undefined);
check("null 回 undefined", normalizeResume(null) === undefined);
check(
  "只有 failure（無指令）回 undefined",
  normalizeResume({ failure: "nope" }) === undefined,
);
const userResume = normalizeResume({
  byId: " mytool -r {id} ",
  latest: " mytool -c ",
  failure: "not found",
});
check("byId 去空白後保留", userResume?.byId === "mytool -r {id}");
check("latest 去空白後保留", userResume?.latest === "mytool -c");
check("failure 保留", userResume?.failure === "not found");
check(
  "byId 缺 {id} 被丟掉，latest 仍保留",
  normalizeResume({ byId: "mytool -r", latest: "mytool -c" })?.byId === undefined,
);
check(
  "byId 缺 {id} 且沒有 latest → 整個 resume 回 undefined",
  normalizeResume({ byId: "mytool -r" }) === undefined,
);
check(
  "編不成 regex 的 failure 被丟掉（指令仍可用）",
  normalizeResume({ latest: "mytool -c", failure: "([unclosed" })?.failure === undefined,
);
check(
  "非字串欄位被忽略",
  normalizeResume({ byId: 42, latest: "mytool -c" })?.byId === undefined,
);
check(
  "正規化結果可直接餵給 resolveResumePlan",
  resolveResumePlan(profileWith(normalizeResume({ byId: "t {id}" })), ["z"], undefined)
    ?.command === "t z",
);

console.log(`agent-resume: ${passed} checks passed`);
