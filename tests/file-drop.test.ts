// 拖放路徑 → PTY 輸入的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/file-drop.test.ts
import assert from "node:assert";
import { test } from "node:test";
import {
  buildDropInput,
  formatDroppedPaths,
  quoteDropPath,
  sanitizeDropText,
} from "../src/components/Terminal/fileDrop.ts";

test("leaves a plain path unquoted on both platforms", () => {
  assert.strictEqual(quoteDropPath("C:\\repo\\a.png", "windows"), "C:\\repo\\a.png");
  assert.strictEqual(quoteDropPath("/home/me/a.png", "posix"), "/home/me/a.png");
});

test("quotes a Windows path containing spaces", () => {
  assert.strictEqual(
    quoteDropPath("C:\\Users\\Aries Chao\\shot.png", "windows"),
    '"C:\\Users\\Aries Chao\\shot.png"',
  );
});

// 回歸點：Windows 的雙引號內反斜線是字面值。若誤套 POSIX 的加倍規則，
// 每個路徑分隔符都會變成 `\\`，CLI 開檔就會失敗。
test("never doubles backslashes on Windows", () => {
  const quoted = quoteDropPath("C:\\Program Files\\x\\a.png", "windows");
  assert.strictEqual(quoted, '"C:\\Program Files\\x\\a.png"');
  assert.ok(!quoted.includes("\\\\"));
});

// 回歸點：結尾反斜線（資料夾拖曳很常見）必須原樣留著。
test("preserves a trailing backslash on Windows", () => {
  assert.strictEqual(quoteDropPath("C:\\my repo\\", "windows"), '"C:\\my repo\\"');
});

test("escapes an embedded double quote on Windows", () => {
  assert.strictEqual(quoteDropPath('C:\\a "b" c.png', "windows"), '"C:\\a ""b"" c.png"');
});

test("quotes POSIX paths with spaces using single quotes", () => {
  assert.strictEqual(quoteDropPath("/home/me/my shot.png", "posix"), "'/home/me/my shot.png'");
});

test("escapes an embedded single quote on POSIX", () => {
  assert.strictEqual(quoteDropPath("/home/it's/a.png", "posix"), `'/home/it'\\''s/a.png'`);
});

// `$` / 反引號在未加引號時會被 shell 展開成別的東西；單引號讓它們變字面值。
test("quotes POSIX paths containing shell expansion characters", () => {
  assert.strictEqual(quoteDropPath("/tmp/$HOME.png", "posix"), "'/tmp/$HOME.png'");
  assert.strictEqual(quoteDropPath("/tmp/`id`.png", "posix"), "'/tmp/`id`.png'");
});

// `&` 在 cmd / PowerShell 是命令分隔符，沒引號的話後半段會被當成另一條指令。
test("quotes Windows paths containing an ampersand", () => {
  assert.strictEqual(quoteDropPath("C:\\a&b.png", "windows"), '"C:\\a&b.png"');
});

test("joins multiple paths with a single space", () => {
  assert.strictEqual(
    formatDroppedPaths(["C:\\a.png", "C:\\b c.png"], "windows"),
    'C:\\a.png "C:\\b c.png"',
  );
});

test("drops empty entries instead of emitting empty quotes", () => {
  assert.strictEqual(formatDroppedPaths(["", "/tmp/a.png", ""], "posix"), "/tmp/a.png");
  assert.strictEqual(formatDroppedPaths([], "posix"), "");
});

// 這是「拖一個檔案卻執行了東西」的路徑：混進來的 CR 等於替使用者按下 Enter。
test("strips control characters that would submit the line", () => {
  assert.strictEqual(sanitizeDropText("/tmp/a.png\r"), "/tmp/a.png");
  assert.strictEqual(sanitizeDropText("/tmp/a\npng"), "/tmp/apng");
  assert.strictEqual(sanitizeDropText("/tmp/\x1b[31ma.png"), "/tmp/[31ma.png");
});

test("buildDropInput quotes and sanitizes in one pass", () => {
  assert.strictEqual(
    buildDropInput(["C:\\my repo\\a.png\r"], "windows"),
    '"C:\\my repo\\a.png"',
  );
  assert.strictEqual(buildDropInput([], "windows"), "");
});

// 順序回歸點：清理必須發生在引號判斷**之前**。反過來的話控制字元自己會命中
// NEEDS_QUOTING 的 `\s`，讓一個本來不需引號的乾淨路徑被包起來 —— 輸出就變成
// 取決於一個看不見的字元。（實機驗證時抓到的真實行為差異。）
test("a stripped control character does not leave a clean path quoted", () => {
  assert.strictEqual(buildDropInput(["C:\\a.png\r"], "windows"), "C:\\a.png");
  assert.strictEqual(buildDropInput(["/tmp/a.png\n"], "posix"), "/tmp/a.png");
});
