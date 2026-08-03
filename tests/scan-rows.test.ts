// 掃描列選取（還原 floor + alt-screen 護欄）的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/scan-rows.test.ts
import assert from "node:assert";
import { scanRows } from "../src/components/Terminal/scanRows.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

/** 第 n 列的內容就是 "L<n>"；超出 total 的列不存在。 */
function reader(total: number) {
  return (row: number) => (row >= 0 && row < total ? `L${row}` : null);
}

// ---- 沒有 floor：等同原本「只讀 viewport」的行為 ----

check(
  "floor=0 讀 baseY 起算的 rows 列",
  JSON.stringify(scanRows(reader(100), 10, 3, 0, false)) === '["L10","L11","L12"]',
);
check(
  "不存在的列被跳過（buffer 比 viewport 短）",
  JSON.stringify(scanRows(reader(12), 10, 3, 0, false)) === '["L10","L11"]',
);

// ---- floor：重播內容不進掃描 ----

check(
  "floor 之下的列被跳過（重播的舊畫面）",
  JSON.stringify(scanRows(reader(100), 10, 4, 12, false)) === '["L12","L13"]',
);
check(
  "全部都在 floor 之下 → 什麼都不掃（不會把舊提示當成作用中的核准）",
  scanRows(reader(100), 10, 3, 50, false).length === 0,
);
check(
  "baseY 已經超過 floor → floor 自動失效，無須清理",
  JSON.stringify(scanRows(reader(100), 60, 2, 50, false)) === '["L60","L61"]',
);
check(
  "floor 剛好等於 baseY → 整個 viewport 都算新內容",
  JSON.stringify(scanRows(reader(100), 10, 2, 10, false)) === '["L10","L11"]',
);

// ---- alt-screen 護欄（最關鍵的一條）----
// agent 進 alternate screen 後 baseY 歸零；若照樣套用 floor，所有列都在 floor
// 之下 → 該 pane 的 agent 偵測會永久失效。

check(
  "alt buffer：floor 一律不套用",
  JSON.stringify(scanRows(reader(100), 0, 3, 40, true)) === '["L0","L1","L2"]',
);
check(
  "alt buffer + baseY 0 + 大 floor：仍讀得到內容（否則偵測永久壞掉）",
  scanRows(reader(100), 0, 24, 999, true).length === 24,
);

console.log(`\nscan-rows: ${passed} checks passed.`);
