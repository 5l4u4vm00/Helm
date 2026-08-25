// Sidebar drag payload / pointer geometry tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/sidebar-drop-position.test.ts
import assert from "node:assert";
import {
  dragKind,
  pointerHalf,
  SESSION_DND_TYPE,
  WORKSPACE_DND_TYPE,
} from "../src/components/SessionSidebar/dropPosition.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// --- dragKind -------------------------------------------------------------
check("session 拖曳被辨識出來", dragKind([SESSION_DND_TYPE, "text/plain"]) === "session");
check("workspace 拖曳被辨識出來", dragKind([WORKSPACE_DND_TYPE]) === "workspace");
// An OS file drag must not turn the sidebar into a drop target.
check("純文字 / 檔案拖曳不是 sidebar 的目標", dragKind(["text/plain", "Files"]) === null);
check("空的 types 不是 sidebar 的目標", dragKind([]) === null);
check(
  "兩種型別都在時 session 優先（只有 session 會同時帶 text/plain）",
  dragKind([WORKSPACE_DND_TYPE, SESSION_DND_TYPE]) === "session",
);

// --- pointerHalf ----------------------------------------------------------
const row = { top: 100, height: 20 };
check("上半部是 before", pointerHalf(104, row) === "before");
check("下半部是 after", pointerHalf(116, row) === "after");
// The halves must partition the row, or a pointer resting on the boundary
// flickers between two insertion positions.
check("正中間算 before", pointerHalf(110, row) === "before");
check("剛好在頂端算 before", pointerHalf(100, row) === "before");
check("剛好在底端算 after", pointerHalf(120, row) === "after");
check("零高度的 rect 不會爆掉", pointerHalf(100, { top: 100, height: 0 }) === "before");

console.log(`\nsidebar-drop-position: ${passed} checks passed`);
