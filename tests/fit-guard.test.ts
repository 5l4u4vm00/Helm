// fit 前的尺寸守衛（純函式）測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/fit-guard.test.ts
//
// 這支測試存在的理由是一個真實的 bug：Terminal.tsx 有三個 fit 呼叫端，其中
// waitForWidth 只檢查寬度、漏了高度，於是冷啟動時「寬已定、高未定」那一瞬間
// fit() 會把格子夾成最小值，重播的裸 write 再把斷行永久烙進 buffer
//（症狀：重啟後 shell 被擠在左側、游標黏在最上方，Windows 上幾乎必中）。
// 三個呼叫端現在共用 canFit 這一個定義，這裡把該定義釘住。
import assert from "node:assert";
import { canFit } from "../src/components/Terminal/fitGuard.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- 正常情況 ----

check("寬高皆為正數 → 可以 fit", canFit({ width: 1180, height: 838 }));
check("極小但非零的尺寸仍可 fit（夾住格子是 xterm 的事，不是守衛的事）", canFit({ width: 1, height: 1 }));

// ---- 0 尺寸：display:none 的 pane ----

check("寬高皆為 0（display:none）→ 不可 fit", !canFit({ width: 0, height: 0 }));

// ---- 這兩個是 bug 本體：只有一邊是 0 ----

check(
  "有寬但高為 0（冷啟動佈局未完成）→ 不可 fit",
  !canFit({ width: 1180, height: 0 }),
);
check(
  "有高但寬為 0（側欄全展開等極端佈局）→ 不可 fit",
  !canFit({ width: 0, height: 838 }),
);

// ---- 防禦性：非有限值與負數 ----
// clientWidth 理論上不會是這些，但這個守衛的價值就在「不確定時不要 fit」。

check("NaN 寬 → 不可 fit", !canFit({ width: Number.NaN, height: 838 }));
check("NaN 高 → 不可 fit", !canFit({ width: 1180, height: Number.NaN }));
check("Infinity → 不可 fit", !canFit({ width: Number.POSITIVE_INFINITY, height: 838 }));
check("負寬 → 不可 fit", !canFit({ width: -10, height: 838 }));
check("負高 → 不可 fit", !canFit({ width: 1180, height: -10 }));

// ---- 對稱性：寬高兩軸沒有特殊待遇 ----
// 原本的 bug 正是「寬被檢查、高沒有」這種不對稱。

check(
  "寬高互換不改變結論（兩軸對稱）",
  canFit({ width: 800, height: 600 }) === canFit({ width: 600, height: 800 }) &&
    canFit({ width: 800, height: 0 }) === canFit({ width: 0, height: 800 }),
);

console.log(`\n# fit-guard: ${passed} checks passed`);
