// Sidebar pointer geometry tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/sidebar-drop-position.test.ts
import assert from "node:assert";
import { pointerHalf } from "../src/components/SessionSidebar/dropPosition.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

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
