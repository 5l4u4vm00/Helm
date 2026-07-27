// 快捷鍵說明的漂移防線：確認說明涵蓋所有實際綁定、所有 i18n key 都存在，
// 且 README 與原生選單提示都與按鍵表一致。
// 執行：node --experimental-strip-types tests/shortcut-docs.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { PREFIX_TABLE, prefixLabel } from "../src/commands/prefix.ts";
import { KEYMAP } from "../src/commands/keymap.ts";
import { SIDEBAR_TABLE } from "../src/components/SessionSidebar/sidebarKeymap.ts";
import { buildShortcutDocs, titleKeyFor } from "../src/commands/shortcutDocs.ts";
import { en } from "../src/i18n/translations/en.ts";
import { zhTW } from "../src/i18n/translations/zh-TW.ts";
import { checkReadme } from "../scripts/gen-shortcut-docs.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

const docs = buildShortcutDocs(false);
const allRows = docs.flatMap((s) => s.rows);

// 1. 每個實際綁定的命令都有 title 對應，且出現在說明中
{
  const missing = [...new Set(PREFIX_TABLE.map((b) => b.commandId))].filter(
    (id) => !titleKeyFor(id),
  );
  check(`每個 PREFIX_TABLE 命令都有 titleKey（缺：${missing.join(", ")}）`, missing.length === 0);

  const keymapMissing = KEYMAP.map((b) => b.commandId).filter((id) => !titleKeyFor(id));
  check(`每個 KEYMAP 命令都有 titleKey（缺：${keymapMissing.join(", ")}）`, keymapMissing.length === 0);

  const docTitleKeys = new Set(allRows.map((r) => r.titleKey));
  const notShown = [...new Set(PREFIX_TABLE.map((b) => b.commandId))].filter(
    (id) => !docTitleKeys.has(titleKeyFor(id)!),
  );
  check(`每個 PREFIX_TABLE 命令都出現在說明中（缺：${notShown.join(", ")}）`, notShown.length === 0);

  const sidebarMissing = SIDEBAR_TABLE.filter((b) => !docTitleKeys.has(b.titleKey));
  check(
    `每個 SIDEBAR_TABLE 條目都出現在說明中（缺：${sidebarMissing.map((b) => b.action).join(", ")}）`,
    sidebarMissing.length === 0,
  );
}

// 2. 所有 i18n key 在兩種語言都存在（避免說明顯示原始 key）
{
  const keys = [
    ...docs.map((s) => s.titleKey),
    ...docs.flatMap((s) => (s.noteKey ? [s.noteKey] : [])),
    ...allRows.map((r) => r.titleKey),
    "shortcut.title",
    "shortcut.dismiss",
  ];
  const missingEn = keys.filter((k) => !(k in en));
  const missingZh = keys.filter((k) => !(k in zhTW));
  check(`en 缺少翻譯：${missingEn.join(", ")}`, missingEn.length === 0);
  check(`zh-TW 缺少翻譯：${missingZh.join(", ")}`, missingZh.length === 0);
}

// 3. README 的產生區塊與產生器輸出逐字相符
{
  check("README 快捷鍵區塊是最新的（否則跑 npm run docs:shortcuts）", checkReadme().ok);
}

// 4. 原生選單 label 上的 "(Ctrl+A x)" 提示與 PREFIX_TABLE 一致
{
  const src = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  // item("<commandId>", l.<label>, "<hint>")
  const re = /item\("([^"]+)",\s*l\.\w+,\s*"((?:[^"\\]|\\.)*)"\)/g;
  const found: Array<[string, string]> = [];
  for (const m of src.matchAll(re)) {
    found.push([m[1], m[2].replace(/\\"/g, '"')]);
  }
  check("在 lib.rs 找到選單提示", found.length > 0);
  const wrong = found.filter(([id, hint]) => prefixLabel(id, false) !== `Ctrl+A ${hint}`);
  check(
    `選單提示與 PREFIX_TABLE 一致（不符：${wrong
      .map(([id, hint]) => `${id}="${hint}" vs ${prefixLabel(id, false)}`)
      .join("; ")}）`,
    wrong.length === 0,
  );
}

console.log(`\nshortcut-docs: ${passed} checks passed`);
