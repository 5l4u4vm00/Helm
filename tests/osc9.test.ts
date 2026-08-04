// OSC 9 payload 過濾的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/osc9.test.ts
import assert from "node:assert";
import { test } from "node:test";
import { decodeOsc9 } from "../src/components/Terminal/osc9.ts";

// 以下三種都是 Codex 0.146.0 binary 內實際存在的通知字串形狀。
test("passes through a Codex approval notification", () => {
  assert.strictEqual(
    decodeOsc9("Approval requested: rm -rf node_modules"),
    "Approval requested: rm -rf node_modules",
  );
});

test("passes through a plan mode prompt", () => {
  assert.strictEqual(
    decodeOsc9("Plan mode prompt: Choose an approach"),
    "Plan mode prompt: Choose an approach",
  );
});

test("passes through a free-text turn-complete preview", () => {
  assert.strictEqual(decodeOsc9("重構完成，已更新 3 個檔案"), "重構完成，已更新 3 個檔案");
});

// 這是修的 bug：Windows Terminal 的進度序列不能被當成「回合結束」。
test("rejects the Windows Terminal progress subcommand", () => {
  assert.strictEqual(decodeOsc9("4;1;50"), null);
});

test("rejects ConEmu subcommands 1-3", () => {
  for (const s of ["1;some title", "2;x", "3;"]) {
    assert.strictEqual(decodeOsc9(s), null, s);
  }
});

test("rejects a bare progress subcommand with no arguments", () => {
  assert.strictEqual(decodeOsc9("4"), null);
});

test("rejects empty and whitespace-only payloads", () => {
  assert.strictEqual(decodeOsc9(""), null);
  assert.strictEqual(decodeOsc9("   "), null);
});

// 規則邊界：真通知可能以數字開頭，不能因此丟掉（漏審批的代價更高）。
test("keeps a notification that merely starts with a digit", () => {
  assert.strictEqual(decodeOsc9("3 files changed"), "3 files changed");
});

// ConEmu 只定義到 4，故更大的數字要放行。
test("keeps a payload starting with a number above the subcommand range", () => {
  assert.strictEqual(decodeOsc9("52;not a subcommand"), "52;not a subcommand");
});

test("trims surrounding whitespace", () => {
  assert.strictEqual(decodeOsc9("  Approval requested by user  "), "Approval requested by user");
});
