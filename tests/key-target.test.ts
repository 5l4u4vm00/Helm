// 執行：node --experimental-strip-types tests/key-target.test.ts
import assert from "node:assert";
import { isTextEntry, type KeyTargetLike } from "../src/commands/keyTarget.ts";

let passed = 0;
function check(name: string, actual: boolean, expected: boolean) {
  assert.strictEqual(actual, expected, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

const el = (t: Partial<KeyTargetLike>): KeyTargetLike => ({ tagName: "DIV", ...t });

// 文字類：輸入框應保有自己的按鍵（Ctrl+A = 全選）
check("text input", isTextEntry(el({ tagName: "INPUT", inputType: "text" })), true);
check("input without type defaults to text", isTextEntry(el({ tagName: "INPUT" })), true);
check("search input", isTextEntry(el({ tagName: "INPUT", inputType: "search" })), true);
check("password input", isTextEntry(el({ tagName: "INPUT", inputType: "password" })), true);
check("number input", isTextEntry(el({ tagName: "INPUT", inputType: "number" })), true);
check("textarea", isTextEntry(el({ tagName: "TEXTAREA" })), true);
check("contenteditable div", isTextEntry(el({ isContentEditable: true })), true);

// 非文字類：這些位置武裝前綴無害
check("checkbox", isTextEntry(el({ tagName: "INPUT", inputType: "checkbox" })), false);
check("radio", isTextEntry(el({ tagName: "INPUT", inputType: "radio" })), false);
check("range", isTextEntry(el({ tagName: "INPUT", inputType: "range" })), false);
check("color", isTextEntry(el({ tagName: "INPUT", inputType: "color" })), false);
check("file", isTextEntry(el({ tagName: "INPUT", inputType: "file" })), false);
check("select", isTextEntry(el({ tagName: "SELECT" })), false);
check("button", isTextEntry(el({ tagName: "BUTTON" })), false);
check("plain div", isTextEntry(el({})), false);
check("null target", isTextEntry(null), false);

// 關鍵回歸：xterm 的輸入槽是 <textarea>，若被當成文字框，前綴就整個失效
check(
  "xterm helper textarea is NOT a text entry",
  isTextEntry(el({ tagName: "TEXTAREA", inTerminal: true })),
  false,
);
check(
  "inTerminal wins over contenteditable",
  isTextEntry(el({ isContentEditable: true, inTerminal: true })),
  false,
);

console.log(`key-target: ${passed} checks passed`);
