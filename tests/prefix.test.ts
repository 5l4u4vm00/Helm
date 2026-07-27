// tmux 風格 prefix（Ctrl+A）狀態機純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/prefix.test.ts
import assert from "node:assert";
import {
  DIGITS_LABEL,
  PREFIX_TABLE,
  isPrefixKey,
  prefixLabel,
  resolvePrefixInput,
  whichKeyHints,
} from "../src/commands/prefix.ts";
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

function runId(armed: boolean, e: KeyEventLike): string | null {
  const a = resolvePrefixInput(armed, e);
  return a.type === "run" ? a.commandId : null;
}

// idle 狀態：只有嚴格 Ctrl+A 會武裝，其他一律 pass
{
  check("Ctrl+A → arm", resolvePrefixInput(false, ev({ key: "a", code: "KeyA", ctrlKey: true })).type === "arm");
  check("isPrefixKey(Ctrl+A)", isPrefixKey(ev({ key: "a", code: "KeyA", ctrlKey: true })));
  check("Cmd+A 不武裝（pass）", resolvePrefixInput(false, ev({ key: "a", code: "KeyA", metaKey: true })).type === "pass");
  check(
    "Ctrl+Shift+A 不武裝",
    resolvePrefixInput(false, ev({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true })).type === "pass",
  );
  check(
    "Ctrl+Alt+A 不武裝",
    resolvePrefixInput(false, ev({ key: "a", code: "KeyA", ctrlKey: true, altKey: true })).type === "pass",
  );
  check("純字母 pass", resolvePrefixInput(false, ev({ key: "c", code: "KeyC" })).type === "pass");
  check("Ctrl+C pass（進終端）", resolvePrefixInput(false, ev({ key: "c", code: "KeyC", ctrlKey: true })).type === "pass");
}

// armed：tmux 慣例鍵（單一字元由字元本身承載 shift）
{
  check(
    'prefix % → split-right（shiftKey 不影響）',
    runId(true, ev({ key: "%", code: "Digit5", shiftKey: true })) === "layout:split-right",
  );
  check(
    'prefix " → split-down',
    runId(true, ev({ key: '"', code: "Quote", shiftKey: true })) === "layout:split-down",
  );
  check("prefix x → close-pane", runId(true, ev({ key: "x", code: "KeyX" })) === "layout:close-pane");
  check("prefix o → focus-next-pane", runId(true, ev({ key: "o", code: "KeyO" })) === "layout:focus-next-pane");
  check("prefix c → session:new", runId(true, ev({ key: "c", code: "KeyC" })) === "session:new");
  check("prefix n → session:next", runId(true, ev({ key: "n", code: "KeyN" })) === "session:next");
  check("prefix p → session:prev", runId(true, ev({ key: "p", code: "KeyP" })) === "session:prev");
  check(
    "prefix r → session:rename-active",
    runId(true, ev({ key: "r", code: "KeyR" })) === "session:rename-active",
  );
  check("prefix w → workspace:new", runId(true, ev({ key: "w", code: "KeyW" })) === "workspace:new");
  check("prefix g → focus:sidebar", runId(true, ev({ key: "g", code: "KeyG" })) === "focus:sidebar");
  check(
    "prefix N（Shift+n）→ reject-active，與小寫 n 區分",
    runId(true, ev({ key: "N", code: "KeyN", shiftKey: true })) === "approval:reject-active",
  );
  check("prefix y → approve-active", runId(true, ev({ key: "y", code: "KeyY" })) === "approval:approve-active");
  check("prefix b → notifications", runId(true, ev({ key: "b", code: "KeyB" })) === "view:toggle-notifications");
  check("prefix i → focus:terminal", runId(true, ev({ key: "i", code: "KeyI" })) === "focus:terminal");
  check(
    "prefix ?（Shift+/）→ shortcuts help",
    runId(true, ev({ key: "?", code: "Slash", shiftKey: true })) === "help:shortcuts",
  );
}

// armed：Ctrl 壓在第二鍵 = 整個 workspace 的審批變體（與單一 session 版本互不干擾）
{
  check(
    "prefix Ctrl+y → approve-all",
    runId(true, ev({ key: "y", code: "KeyY", ctrlKey: true })) === "approval:approve-all",
  );
  check(
    "prefix Ctrl+n → reject-all",
    runId(true, ev({ key: "n", code: "KeyN", ctrlKey: true })) === "approval:reject-all",
  );
  check(
    "小寫 n 仍是 session:next（不被 Ctrl 版本吃掉）",
    runId(true, ev({ key: "n", code: "KeyN" })) === "session:next",
  );
  check(
    "y 仍是 approve-active",
    runId(true, ev({ key: "y", code: "KeyY" })) === "approval:approve-active",
  );
}

// armed：方向鍵（純方向 = 切焦點；Ctrl+方向 = 調大小；Shift+方向 = 未知）
{
  check(
    "prefix ← → focus-left",
    runId(true, ev({ key: "ArrowLeft", code: "ArrowLeft" })) === "layout:focus-left",
  );
  check(
    "prefix Ctrl+← → resize-left",
    runId(true, ev({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true })) === "layout:resize-left",
  );
  check(
    "prefix Shift+← 未知 → cancel",
    resolvePrefixInput(true, ev({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true })).type === "cancel",
  );
}

// armed：數字用 e.code 比對（鍵盤配置無關）
{
  check("prefix 3 → switch-3", runId(true, ev({ key: "3", code: "Digit3" })) === "session:switch-3");
  check(
    "key 非數字但 code 是 Digit1 仍比中",
    runId(true, ev({ key: "&", code: "Digit1" })) === "session:switch-1",
  );
  check(
    "Shift+數字不比中（cancel）",
    resolvePrefixInput(true, ev({ key: "#", code: "Digit3", shiftKey: true })).type === "cancel",
  );
}

// armed：Tab / Shift+Tab
{
  check("prefix Tab → cycle-region", runId(true, ev({ key: "Tab", code: "Tab" })) === "focus:cycle-region");
  check(
    "prefix Shift+Tab → cycle-region-back",
    runId(true, ev({ key: "Tab", code: "Tab", shiftKey: true })) === "focus:cycle-region-back",
  );
}

// armed：字面傳送（screen 的 C-a a / C-a C-a）
{
  check("prefix a → send-prefix", runId(true, ev({ key: "a", code: "KeyA" })) === "terminal:send-prefix");
  check(
    "prefix Ctrl+A → send-prefix",
    runId(true, ev({ key: "a", code: "KeyA", ctrlKey: true })) === "terminal:send-prefix",
  );
}

// armed：取消與忽略
{
  check("prefix Esc → cancel", resolvePrefixInput(true, ev({ key: "Escape", code: "Escape" })).type === "cancel");
  check("prefix 未知鍵 q → cancel", resolvePrefixInput(true, ev({ key: "q", code: "KeyQ" })).type === "cancel");
  check(
    "prefix Cmd+X → cancel（無 meta 綁定）",
    resolvePrefixInput(true, ev({ key: "x", code: "KeyX", metaKey: true })).type === "cancel",
  );
  check(
    "prefix 單獨 Shift → ignore（保持武裝）",
    resolvePrefixInput(true, ev({ key: "Shift", code: "ShiftLeft", shiftKey: true })).type === "ignore",
  );
  check(
    "prefix 單獨 Control → ignore",
    resolvePrefixInput(true, ev({ key: "Control", code: "ControlLeft", ctrlKey: true })).type === "ignore",
  );
}

// 表格健全性：無重複鍵位（key/code + ctrl + shift 唯一）
{
  const sigs = PREFIX_TABLE.map(
    (b) => `${b.code ?? ""}|${b.key ?? ""}|${b.ctrl ?? false}|${b.shift ?? false}`,
  );
  check("PREFIX_TABLE 鍵位不重複", new Set(sigs).size === sigs.length);
}

// prefixLabel：mac / windows 顯示格式
{
  check("mac label ⌃A %", prefixLabel("layout:split-right", true) === "⌃A %");
  check("win label Ctrl+A %", prefixLabel("layout:split-right", false) === "Ctrl+A %");
  check("win label Ctrl+A Ctrl+←", prefixLabel("layout:resize-left", false) === "Ctrl+A Ctrl+←");
  check("mac label ⌃A ⌃←", prefixLabel("layout:resize-left", true) === "⌃A ⌃←");
  check("win label Ctrl+A 3", prefixLabel("session:switch-3", false) === "Ctrl+A 3");
  check("mac label ⌃A ⇧Tab", prefixLabel("focus:cycle-region-back", true) === "⌃A ⇧Tab");
  check("palette:open 非 prefix → undefined", prefixLabel("palette:open", false) === undefined);
}

// whichKeyHints：數字摺疊、重複命令去重
{
  const hints = whichKeyHints(true);
  check("數字摺疊為單一列", hints.filter((h) => h.keyLabel === DIGITS_LABEL).length === 1);
  check(
    "無個別數字列",
    hints.every((h) => !/^[1-9]$/.test(h.keyLabel)),
  );
  const ids = hints.map((h) => h.commandId);
  check("命令不重複（send-prefix 只列一次）", new Set(ids).size === ids.length);
  // switch-1..9 共 9 個命令摺疊成 1 列，故 hints 比表內唯一命令數少 8。
  check(
    "涵蓋所有表內命令",
    new Set(PREFIX_TABLE.map((b) => b.commandId)).size === ids.length + 8,
  );
}

console.log(`\nprefix: ${passed} checks passed`);
