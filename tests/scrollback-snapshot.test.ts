// 快照檔案格式的純函式測試：寫出/讀回的往返、版本不符整份丟棄、壞檔一律拒收、
// 讀進來的內容也套上限（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/scrollback-snapshot.test.ts
import assert from "node:assert";
import {
  MAX_SNAPSHOT_LINES,
  parseSnapshot,
  serializeSnapshot,
  SNAPSHOT_VERSION,
} from "../src/components/Terminal/replay.ts";
import { scrollbackFileName, SCROLLBACK_PREFIX } from "../src/ipc/appStore.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- 往返 ----

const savedAt = 1_700_000_000_000;
const text = serializeSnapshot(["first", "second"], savedAt);
const round = parseSnapshot(text);

check("檔頭帶得出版本與時間", text.startsWith(`helm-scrollback ${SNAPSHOT_VERSION} ${savedAt}\n`));
check("寫出的內容以換行結尾", text.endsWith("\n"));
check("讀回同一份列", round !== null && JSON.stringify(round.lines) === '["first","second"]');
check("讀回 savedAt（footer 的「多久以前」靠它）", round?.savedAt === savedAt);
check("讀回的版本就是目前版本", round?.version === SNAPSHOT_VERSION);
check(
  "空白列在中間時不會被往返弄丟",
  JSON.stringify(parseSnapshot(serializeSnapshot(["a", "", "b"], savedAt))?.lines) ===
    '["a","","b"]',
);
check(
  "savedAt 是小數/負數 → 正規化成整數且不為負",
  serializeSnapshot(["a"], -12.7).startsWith(`helm-scrollback ${SNAPSHOT_VERSION} 0\n`),
);

// ---- 版本不符：整份丟棄，不做部分相容 ----

check(
  "未來版本 → null",
  parseSnapshot(`helm-scrollback ${SNAPSHOT_VERSION + 1} ${savedAt}\nline\n`) === null,
);
check("版本 0 → null", parseSnapshot(`helm-scrollback 0 ${savedAt}\nline\n`) === null);

// ---- 壞檔一律拒收（症狀不能是把髒東西貼回畫面） ----

check("空字串 → null", parseSnapshot("") === null);
check("沒有換行 → null", parseSnapshot("helm-scrollback 1 123") === null);
check("檔頭魔法字串不對 → null", parseSnapshot("something-else 1 123\nline\n") === null);
check("檔頭少欄位 → null", parseSnapshot("helm-scrollback 1\nline\n") === null);
check("版本不是數字 → null", parseSnapshot("helm-scrollback x 123\nline\n") === null);
check(
  "只有檔頭、沒有內容 → null（沒東西可重播）",
  parseSnapshot(`helm-scrollback ${SNAPSHOT_VERSION} ${savedAt}\n`) === null,
);
check(
  "內容全是空白列 → null",
  parseSnapshot(`helm-scrollback ${SNAPSHOT_VERSION} ${savedAt}\n\n   \n`) === null,
);
check(
  "檔頭以 CRLF 結尾也讀得懂（被別的工具改過）",
  parseSnapshot(`helm-scrollback ${SNAPSHOT_VERSION} ${savedAt}\r\nline\n`) !== null,
);
check(
  "手動塞進來的控制字元在讀取時被消毒",
  parseSnapshot(`helm-scrollback ${SNAPSHOT_VERSION} ${savedAt}\n\x1b]0;title\x07x\n`)
    ?.lines[0] === "]0;titlex",
);

// ---- 讀進來的檔案也套上限（手動編輯/損壞的檔案不該變成一大坨重播） ----

const huge = serializeSnapshot(
  Array.from({ length: MAX_SNAPSHOT_LINES + 500 }, (_, i) => `L${i}`),
  savedAt,
);
const capped = parseSnapshot(huge);
check("超長檔案讀回時被裁到上限", capped?.lines.length === MAX_SNAPSHOT_LINES);
check(
  "而且留的是尾端（最近的畫面）",
  capped?.lines[capped.lines.length - 1] === `L${MAX_SNAPSHOT_LINES + 499}`,
);

// ---- 檔名：每個 session 一個檔，壞檔只損失一個 pane ----

check(
  "檔名帶 prefix 與 .txt",
  scrollbackFileName("abc-123").startsWith(SCROLLBACK_PREFIX) &&
    scrollbackFileName("abc-123").endsWith(".txt"),
);
check(
  "不同 session 得到不同檔名",
  scrollbackFileName("a") !== scrollbackFileName("b"),
);
check(
  "非法字元被濾掉（Rust 端的檔名白名單不會被撞到）",
  scrollbackFileName("../../etc/passwd") === `${SCROLLBACK_PREFIX}etcpasswd.txt`,
);

console.log(`\n${passed} checks passed`);
