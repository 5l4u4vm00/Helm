// 前端用到的每個 window API 都必須在 capability 裡拿到授權。
// 執行：node --experimental-strip-types tests/window-capability.test.ts
//
// 為什麼值得一個測試：core:window:default 只給唯讀查詢，任何會改變視窗狀態的
// 呼叫（destroy / setFocus / unminimize …）沒明確授權就會在執行期 reject，而
// TypeScript 完全看不出來。destroy() 的那次 reject 尤其致命 —— 視窗一旦有
// `tauri://close-requested` 的 JS listener，Rust 端就無條件攔下關窗，所以少一條
// 授權不是「快照沒寫出去」而是「使用者按關閉鈕關不掉 app」。
import assert from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath 而非 .pathname：repo 路徑含空白時 pathname 會留著 %20。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const CAPABILITY = join(ROOT, "src-tauri", "capabilities", "default.json");

/**
 * core:window:default 授權的（唯讀）指令，抄自 tauri 2 的 core:window default
 * permission set。gen/schemas 不進版控，所以這份清單只能寫在這裡；它只會隨
 * tauri 升級而變動，而且變動方向是「變多」，漏列只會讓測試更嚴格。
 */
const DEFAULT_GRANTED = new Set([
  "getAllWindows",
  "scaleFactor",
  "innerPosition",
  "outerPosition",
  "innerSize",
  "outerSize",
  "isFullscreen",
  "isMinimized",
  "isMaximized",
  "isFocused",
  "isDecorated",
  "isResizable",
  "isMaximizable",
  "isMinimizable",
  "isClosable",
  "isVisible",
  "isEnabled",
  "title",
  "currentMonitor",
  "primaryMonitor",
  "monitorFromPoint",
  "availableMonitors",
  "cursorPosition",
  "theme",
  "isAlwaysOnTop",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function permissionName(method: string): string {
  return `core:window:allow-${method.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

test("every window API the frontend calls is granted by the capability", () => {
  const permissions: string[] = JSON.parse(readFileSync(CAPABILITY, "utf8")).permissions;
  const granted = new Set(permissions);

  const calls = new Map<string, string>(); // method → 出現的檔案
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    // 只看真的拿到視窗把手的檔案，避免把同名的區域變數也算進來。
    if (!text.includes("getCurrentWindow")) continue;
    for (const m of text.matchAll(/(?:\bwin|getCurrentWindow\(\))\.([a-zA-Z]\w*)\(/g)) {
      const method = m[1];
      // onXxx 是事件訂閱，走 core:event（core:default 已含），不是 window 指令。
      if (/^on[A-Z]/.test(method)) continue;
      if (DEFAULT_GRANTED.has(method)) continue;
      if (!calls.has(method)) calls.set(method, file.slice(ROOT.length));
    }
  }

  // 找不到任何呼叫代表上面的偵測壞了（例如變數改名），那才是最該擋下的情形。
  assert.ok(calls.size > 0, "no window API calls found — the scan regex is stale");

  for (const [method, file] of calls) {
    assert.ok(
      granted.has(permissionName(method)),
      `${file} calls window.${method}() but capabilities/default.json lacks ${permissionName(method)}`,
    );
  }
});
