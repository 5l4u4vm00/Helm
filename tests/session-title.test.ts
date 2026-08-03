// Pure session-title helper tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/session-title.test.ts
import assert from "node:assert";
import {
  nextSessionTitle,
  resolveRename,
  shouldAcceptAutoTitle,
} from "../src/store/sessionTitle.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// --- shouldAcceptAutoTitle ---

check(
  "未鎖定時接受新的自動標題",
  shouldAcceptAutoTitle({ title: "Session 1" }, "⠋ building") === true,
);

check(
  "未鎖定但標題相同時拒絕（避免 PTY 頻率的空轉 set）",
  shouldAcceptAutoTitle({ title: "zsh" }, "zsh") === false,
);

// 核心迴歸：Claude Code 忙碌時每個 spinner tick 都重寫標題。
check(
  "已鎖定時拒絕任何自動標題",
  shouldAcceptAutoTitle({ title: "my-name", titleLocked: true }, "⠙ thinking") === false,
);

check(
  "已鎖定時連空字串也拒絕（CLI 退出會清空標題）",
  shouldAcceptAutoTitle({ title: "my-name", titleLocked: true }, "") === false,
);

check(
  "titleLocked: false 等同未鎖定",
  shouldAcceptAutoTitle({ title: "a", titleLocked: false }, "b") === true,
);

// --- resolveRename ---

{
  const r = resolveRename("  api server  ");
  check("改名會 trim 前後空白", r.kind === "set" && r.title === "api server");
}

check("空字串代表解鎖", resolveRename("").kind === "unlock");
check("純空白也代表解鎖", resolveRename("   ").kind === "unlock");

{
  const r = resolveRename("x");
  check("單一字元是有效名稱", r.kind === "set" && r.title === "x");
}

// ---- nextSessionTitle：從既有清單推導，重啟後不撞名 ----

check("空清單 → Session 1", nextSessionTitle([]) === "Session 1");
check(
  "[Session 1] → Session 2",
  nextSessionTitle([{ title: "Session 1" }]) === "Session 2",
);
check(
  "取最大值 +1（不重用已刪除的號碼）",
  nextSessionTitle([{ title: "Session 1" }, { title: "Session 3" }]) === "Session 4",
);
check(
  "還原三個 session 之後不會又叫 Session 1（module counter 的病）",
  nextSessionTitle([
    { title: "Session 1" },
    { title: "Session 2" },
    { title: "Session 3" },
  ]) === "Session 4",
);
check(
  "自訂名稱與 launcher 名稱不參與編號",
  nextSessionTitle([{ title: "api server" }, { title: "Claude Code" }]) === "Session 1",
);
check(
  "非十進位尾綴不算數（Session 2x）",
  nextSessionTitle([{ title: "Session 2x" }]) === "Session 1",
);
check(
  "鎖定名稱的 session 一樣不影響",
  nextSessionTitle([{ title: "Session 5", titleLocked: true }]) === "Session 6",
);

console.log(`session-title: ${passed} checks passed`);
