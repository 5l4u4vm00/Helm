// 全域快捷鍵 keymap 純函式測試（不需 GUI / Tauri）。
// prefix（Ctrl+A）改制後 KEYMAP 只剩 ⌘⇧P；序列鍵位測試見 prefix.test.ts。
// 執行：node --experimental-strip-types tests/keymap.test.ts
import assert from "node:assert";
import { matchBinding, shortcutLabel } from "../src/commands/keymap.ts";
import type { KeyEventLike } from "../src/commands/types.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function ev(partial: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

// Mod 對 ctrlKey / metaKey 一視同仁
{
  check(
    "Ctrl+Shift+P → palette:open",
    matchBinding(ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true })) ===
      "palette:open",
  );
  check(
    "Cmd+Shift+P → palette:open",
    matchBinding(ev({ key: "P", code: "KeyP", metaKey: true, shiftKey: true })) ===
      "palette:open",
  );
  check(
    "Ctrl+Shift+Alt+P（多帶 Alt）不比中",
    matchBinding(
      ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, altKey: true }),
    ) === null,
  );
}

// 純終端鍵與已移除的舊直接綁定一律不可比中
{
  check("Ctrl+C 不比中", matchBinding(ev({ key: "c", code: "KeyC", ctrlKey: true })) === null);
  check("Ctrl+W 不比中", matchBinding(ev({ key: "w", code: "KeyW", ctrlKey: true })) === null);
  check("純 Esc 不比中", matchBinding(ev({ key: "Escape", code: "Escape" })) === null);
  check("純字母不比中", matchBinding(ev({ key: "p", code: "KeyP" })) === null);
  check(
    "Ctrl+A 不屬於 KEYMAP（由 prefix 狀態機處理）",
    matchBinding(ev({ key: "a", code: "KeyA", ctrlKey: true })) === null,
  );
  check(
    "舊綁定 Ctrl+Shift+D 已移除",
    matchBinding(ev({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true })) === null,
  );
  check(
    "舊綁定 Ctrl+\\ 已移除",
    matchBinding(ev({ key: "\\", code: "Backslash", ctrlKey: true })) === null,
  );
  check("舊綁定 F6 已移除", matchBinding(ev({ key: "F6", code: "F6" })) === null);
  check(
    "舊綁定 Ctrl+1 已移除",
    matchBinding(ev({ key: "1", code: "Digit1", ctrlKey: true })) === null,
  );
}

// shortcutLabel：直接綁定用 ⌘ 格式，其餘委派 prefix 序列格式
{
  check("mac label ⇧⌘P", shortcutLabel("palette:open", true) === "⇧⌘P");
  check("win label Ctrl+Shift+P", shortcutLabel("palette:open", false) === "Ctrl+Shift+P");
  check(
    "prefix 委派 mac ⌃A %",
    shortcutLabel("layout:split-right", true) === "⌃A %",
  );
  check(
    "prefix 委派 win Ctrl+A %",
    shortcutLabel("layout:split-right", false) === "Ctrl+A %",
  );
  check(
    'prefix 委派 ⌃A "',
    shortcutLabel("layout:split-down", true) === '⌃A "',
  );
  // 每個靜態命令現在都有綁定，只有動態（palette 專用）命令沒有。
  check("無綁定 → undefined", shortcutLabel("session:switch:abc123", false) === undefined);
}

console.log(`\nkeymap: ${passed} checks passed`);
