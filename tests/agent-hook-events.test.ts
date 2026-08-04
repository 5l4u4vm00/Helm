// Hook 事件正規化與 hook-waiting 寬限的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/agent-hook-events.test.ts
import assert from "node:assert";
import { normalizeHookPayload, profileIdForSource } from "../src/agents/hookEvents.ts";
import { deriveNotifySignal } from "../src/agents/engine.ts";
import { BUILTIN_PROFILES } from "../src/agents/builtins.ts";
import {
  HOOK_WAITING_GRACE_MS,
  clearHookWaiting,
  clearScanState,
  hasHookWaiting,
  isHookWaitingFresh,
  markHookWaiting,
} from "../src/store/scanState.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- profileIdForSource ----
check("source claude-code → claude-code", profileIdForSource("claude-code") === "claude-code");
check(
  "source claude-code-statusline → claude-code",
  profileIdForSource("claude-code-statusline") === "claude-code",
);
check("source codex → codex", profileIdForSource("codex") === "codex");
check("未知 source → null", profileIdForSource("mystery") === null);

// ---- PermissionRequest（Claude Code 欄位）----
{
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PermissionRequest",
    session_id: "abc",
    cwd: "/repo",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  check("PermissionRequest → permission", ev?.kind === "permission");
  check(
    "permission 提示 = 工具名 + 指令",
    ev?.kind === "permission" && ev.prompt === "Bash: npm test",
  );
}
{
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PermissionRequest",
    tool_name: "Edit",
    tool_input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
  });
  check(
    "permission 檔案工具取 file_path",
    ev?.kind === "permission" && ev.prompt === "Edit: src/a.ts",
  );
}
{
  // Codex hooks 同欄位；patch 類 tool_input 用 path。
  const ev = normalizeHookPayload("codex", {
    hook_event_name: "PermissionRequest",
    turn_id: "t1",
    tool_name: "apply_patch",
    tool_input: { path: "src/b.rs" },
  });
  check(
    "Codex PermissionRequest 正規化",
    ev?.kind === "permission" && ev.prompt === "apply_patch: src/b.rs",
  );
}
{
  // 無可辨識參數 → 序列化整個 tool_input；超長截到 200。
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "x".repeat(500) },
  });
  check("permission 提示截斷至 200", ev?.kind === "permission" && ev.prompt.length === 200);
}
{
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PermissionRequest",
    tool_name: "WebSearch",
    tool_input: {},
  });
  check(
    "空 tool_input 只留工具名",
    ev?.kind === "permission" && ev.prompt === "WebSearch",
  );
}

// ---- Stop / PostToolUse ----
check(
  "Stop → stop",
  normalizeHookPayload("claude-code", { hook_event_name: "Stop" })?.kind === "stop",
);
{
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "docs/readme.md", content: "hi" },
  });
  check(
    "PostToolUse 檔案工具 → toolDone + file",
    ev?.kind === "toolDone" && ev.file?.op === "Write" && ev.file.path === "docs/readme.md",
  );
}
{
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  check("PostToolUse 非檔案工具 → toolDone 無 file", ev?.kind === "toolDone" && !ev.file);
}
{
  // provenance：hook 來的路徑可信（絕對），且 payload.cwd 是這次工具呼叫當下
  // agent 的即時工作目錄——比 session 建立時的 cwd 快照更適合當 git 錨點。
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    cwd: "/repo",
    tool_input: { file_path: "/repo/src/a.ts" },
  });
  check(
    "PostToolUse 標記 source: hook 並帶上 cwd",
    ev?.kind === "toolDone" && ev.file?.source === "hook" && ev.file.cwd === "/repo",
  );
}
{
  const ev = normalizeHookPayload("claude-code", {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/a.ts" },
  });
  check(
    "payload 沒有 cwd 時 file.cwd 為 undefined",
    ev?.kind === "toolDone" && ev.file?.source === "hook" && ev.file.cwd === undefined,
  );
}

// ---- statusline usage ----
{
  const ev = normalizeHookPayload("claude-code-statusline", {
    cost: { total_cost_usd: 0.1234 },
    context_window: {
      current_usage: {
        input_tokens: 1500,
        output_tokens: 200,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
      remaining_percentage: 92,
    },
  });
  check(
    "statusline → usage",
    ev?.kind === "usage" &&
      ev.usage.cost === 0.1234 &&
      ev.usage.tokensIn === 1500 &&
      ev.usage.tokensOut === 200 &&
      ev.usage.contextLeftPercent === 92,
  );
}
{
  // remaining_percentage 可為 null（官方 schema）。Toolbar 這時才 fallback 到
  // token 顯示——token 欄位讀錯正是在這條路徑上暴露。
  const ev = normalizeHookPayload("claude-code-statusline", {
    context_window: {
      current_usage: { input_tokens: 800, output_tokens: 90 },
      remaining_percentage: null,
    },
  });
  check(
    "statusline remaining_percentage null → 仍有 token 數",
    ev?.kind === "usage" &&
      ev.usage.contextLeftPercent === undefined &&
      ev.usage.tokensIn === 800 &&
      ev.usage.tokensOut === 90,
  );
}
{
  // current_usage 為 null（首次 API 呼叫前 / compact 後）→ token 缺席但不當掉。
  const ev = normalizeHookPayload("claude-code-statusline", {
    context_window: { current_usage: null, remaining_percentage: 77 },
  });
  check(
    "statusline current_usage null → 只有 context%",
    ev?.kind === "usage" &&
      ev.usage.tokensIn === undefined &&
      ev.usage.tokensOut === undefined &&
      ev.usage.contextLeftPercent === 77,
  );
}
check(
  "statusline 無用量欄位 → 丟棄",
  normalizeHookPayload("claude-code-statusline", { model: { id: "x" } }) === undefined,
);

// ---- statusline plan usage (rate_limits) ----
{
  const ev = normalizeHookPayload("claude-code-statusline", {
    cost: { total_cost_usd: 0.5 },
    context_window: { remaining_percentage: 80 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
  });
  check(
    "statusline rate_limits → planUsage 剩餘 %",
    ev?.kind === "usage" &&
      ev.usage.planUsage?.fiveHourLeftPercent === 76.5 &&
      ev.usage.planUsage?.sevenDayLeftPercent === 58.8 &&
      ev.usage.planUsage?.fiveHourResetsAt === 1738425600 &&
      ev.usage.planUsage?.sevenDayResetsAt === 1738857600,
  );
}
{
  // 無 rate_limits（僅 context_window）→ planUsage undefined，其餘照舊。
  const ev = normalizeHookPayload("claude-code-statusline", {
    context_window: { remaining_percentage: 92 },
  });
  check(
    "statusline 無 rate_limits → planUsage undefined",
    ev?.kind === "usage" && ev.usage.contextLeftPercent === 92 && ev.usage.planUsage === undefined,
  );
}
{
  // 只有 rate_limits、無 cost/context → 仍回 usage（不被丟棄）。
  const ev = normalizeHookPayload("claude-code-statusline", {
    rate_limits: { five_hour: { used_percentage: 10 } },
  });
  check(
    "statusline 只有 rate_limits → 仍回 usage",
    ev?.kind === "usage" && ev.usage.planUsage?.fiveHourLeftPercent === 90,
  );
}

// ---- 防禦：壞 payload 一律丟棄 ----
check("非物件 payload → 丟棄", normalizeHookPayload("claude-code", "junk") === undefined);
check("null payload → 丟棄", normalizeHookPayload("claude-code", null) === undefined);
check(
  "未知事件 → 丟棄",
  normalizeHookPayload("claude-code", { hook_event_name: "SessionStart" }) === undefined,
);

// ---- hook-waiting 寬限（scanState）----
{
  const id = "s1";
  const t0 = 1_000_000;
  check("初始無 hook waiting", !hasHookWaiting(id));
  markHookWaiting(id, t0);
  check("mark 後 hasHookWaiting", hasHookWaiting(id));
  check("寬限期內 fresh", isHookWaitingFresh(id, t0 + HOOK_WAITING_GRACE_MS));
  check("寬限期後不 fresh", !isHookWaitingFresh(id, t0 + HOOK_WAITING_GRACE_MS + 1));
  check("過期後標記仍在（prompt 不被 scan 覆蓋）", hasHookWaiting(id));
  clearHookWaiting(id);
  check("clear 後標記消失", !hasHookWaiting(id));
  markHookWaiting(id, t0);
  clearScanState(id);
  check("clearScanState 一併清除", !hasHookWaiting(id));
}

// ---- OSC 9 通知訊號（deriveNotifySignal）----
{
  const codex = BUILTIN_PROFILES.find((p) => p.id === "codex")!;
  const claude = BUILTIN_PROFILES.find((p) => p.id === "claude-code")!;
  const exec = deriveNotifySignal(codex, "Approval requested: rm -rf node_modules");
  check("OSC9 exec 審批 → waiting", exec?.state === "waiting");
  check(
    "OSC9 waiting 提示 = 訊息本文",
    exec?.prompt === "Approval requested: rm -rf node_modules",
  );
  check(
    "OSC9 edit 審批 → waiting",
    deriveNotifySignal(codex, "Codex wants to edit src/a.ts")?.state === "waiting",
  );
  const plan = deriveNotifySignal(codex, "Plan mode prompt: Choose an approach");
  check("OSC9 plan prompt → waiting", plan?.state === "waiting");
  check("OSC9 plan prompt kind → plan", plan?.kind === "plan");
  check(
    "OSC9 turn-complete（任意回應預覽）→ done",
    deriveNotifySignal(codex, "重構完成，已更新 3 個檔案")?.state === "done",
  );
  check(
    "無 notify pattern 的 profile → undefined",
    deriveNotifySignal(claude, "Approval requested: x") === undefined,
  );
}

console.log(`\nagent-hook-events: ${passed} checks passed`);
