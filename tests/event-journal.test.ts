// 事件日記磁碟格式的測試（純函式，不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/event-journal.test.ts
import assert from "node:assert";
import {
  JOURNAL_KEEP_LINES,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_LINES,
  JOURNAL_VERSION,
  journalLines,
  parseEntry,
  parseJournal,
  rotatedText,
  serializeEntry,
  shouldRotate,
  tailEntries,
  utf8Bytes,
} from "../src/store/journalFormat.ts";
import {
  NOTIFICATION_CAP,
  isWaitingKind,
  type AppNotification,
  type NotifyKind,
} from "../src/store/notificationCenter.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

let seq = 0;
function make(over: Partial<AppNotification> & { kind: NotifyKind }): AppNotification {
  seq += 1;
  return {
    id: `n${seq}`,
    sessionId: "s1",
    sessionTitle: "Session 1",
    createdAt: 1700000000000 + seq,
    read: false,
    resolved: !isWaitingKind(over.kind),
    ...over,
  };
}

const ALL_KINDS: NotifyKind[] = [
  "approval",
  "question",
  "plan",
  "done",
  "error",
  "interrupted",
  "stalled",
];

// ---- round-trip：寫出再讀回等於原本的內容（read/resolved 除外） ----

{
  const entry = make({
    kind: "approval",
    agentLabel: "Claude Code",
    text: "Bash: rm -rf build",
  });
  const back = parseEntry(serializeEntry(entry));
  check("round-trip 解析成功", back !== null);
  check(
    "round-trip 保留每個欄位",
    back!.id === entry.id &&
      back!.kind === entry.kind &&
      back!.sessionId === entry.sessionId &&
      back!.sessionTitle === entry.sessionTitle &&
      back!.agentLabel === entry.agentLabel &&
      back!.text === entry.text &&
      back!.createdAt === entry.createdAt,
  );
  check("讀回一律 read + resolved", back!.read && back!.resolved);
  check("序列化不含 read / resolved（讀回時覆寫，存了只是浪費）",
    !serializeEntry(entry).includes("read") && !serializeEntry(entry).includes("resolved"));
}

{
  // 未解決的 waiting 也一樣：它的 PTY 早就不在了，開機不該有「等你回答」的殘留。
  const pending = make({ kind: "plan", text: "Approve plan?" });
  check("waiting 原本未解決", !pending.resolved && !pending.read);
  const back = parseEntry(serializeEntry(pending))!;
  check("未解決的 waiting 讀回後也是 resolved + read", back.resolved && back.read);
}

{
  const bare = make({ kind: "done" });
  const back = parseEntry(serializeEntry(bare))!;
  check(
    "無 agentLabel / text 時不留下 undefined 欄位",
    !("agentLabel" in back) && !("text" in back),
  );
}

check(
  "七種 kind 都能 round-trip",
  ALL_KINDS.every((kind) => parseEntry(serializeEntry(make({ kind })))?.kind === kind),
);

// ---- 一行一筆的不變量：內文帶換行也不能拆行 ----

{
  const line = serializeEntry(make({ kind: "error", text: "line1\nline2\r\nline3" }));
  check("多行內文序列化後仍是單行", !line.includes("\n") && !line.includes("\r"));
  check("多行內文讀回後換行還在", parseEntry(line)!.text === "line1\nline2\r\nline3");
}

// ---- 長度上限：一筆病態的長提示不該撐爆整份日記 ----

{
  const long = serializeEntry(
    make({ kind: "approval", text: "x".repeat(5000), sessionTitle: "t".repeat(500) }),
  );
  const back = parseEntry(long)!;
  check("內文截到上限", back.text!.length === 200);
  check("標題截到上限", back.sessionTitle.length === 120);
}

// ---- 壞行：只丟那一行，不能讓整份日記失效 ----

{
  const good1 = serializeEntry(make({ kind: "done", sessionId: "sa" }));
  const good2 = serializeEntry(make({ kind: "error", sessionId: "sb" }));
  const text = [good1, "{ 這行不是 JSON", good2, "", "   "].join("\n");
  const parsed = parseJournal(text);
  check("壞行之外的兩筆都在", parsed.length === 2);
  check("順序即 append 順序", parsed[0].sessionId === "sa" && parsed[1].sessionId === "sb");
  check("空白行不算一筆", journalLines(text).length === 3);
}

{
  // 截斷的尾巴（app 被 kill 時最可能出現的壞行）不該連前面一起毀掉。
  const good = serializeEntry(make({ kind: "stalled" }));
  const truncated = serializeEntry(make({ kind: "done" })).slice(0, 30);
  check("截斷的最後一行只丟自己", parseJournal(`${good}\n${truncated}`).length === 1);
}

const badLines: [string, string][] = [
  ["不是 JSON", "nope"],
  ["JSON 陣列", "[1,2,3]"],
  ["JSON 純量", "42"],
  ["JSON null", "null"],
  ["缺 id", JSON.stringify({ v: 1, kind: "done", sessionId: "s", sessionTitle: "t", createdAt: 1 })],
  ["id 空字串", JSON.stringify({ v: 1, id: "", kind: "done", sessionId: "s", sessionTitle: "t", createdAt: 1 })],
  ["id 非字串", JSON.stringify({ v: 1, id: 7, kind: "done", sessionId: "s", sessionTitle: "t", createdAt: 1 })],
  ["缺 kind", JSON.stringify({ v: 1, id: "a", sessionId: "s", sessionTitle: "t", createdAt: 1 })],
  ["sessionId 空字串", JSON.stringify({ v: 1, id: "a", kind: "done", sessionId: "", sessionTitle: "t", createdAt: 1 })],
  ["sessionTitle 非字串", JSON.stringify({ v: 1, id: "a", kind: "done", sessionId: "s", sessionTitle: 3, createdAt: 1 })],
  ["createdAt 非數字", JSON.stringify({ v: 1, id: "a", kind: "done", sessionId: "s", sessionTitle: "t", createdAt: "1" })],
  ["createdAt NaN（JSON 寫成 null）", JSON.stringify({ v: 1, id: "a", kind: "done", sessionId: "s", sessionTitle: "t", createdAt: NaN })],
  ["text 非字串", JSON.stringify({ v: 1, id: "a", kind: "done", sessionId: "s", sessionTitle: "t", createdAt: 1, text: 5 })],
  ["agentLabel 非字串", JSON.stringify({ v: 1, id: "a", kind: "done", sessionId: "s", sessionTitle: "t", createdAt: 1, agentLabel: {} })],
];

for (const [name, line] of badLines) {
  check(`壞行丟棄：${name}`, parseEntry(line) === null);
}

// ---- 未知 kind / 未知版號 ----

{
  const base = { v: 1, id: "a", sessionId: "s", sessionTitle: "t", createdAt: 1 };
  check("未知 kind 丟棄", parseEntry(JSON.stringify({ ...base, kind: "meltdown" })) === null);
  check(
    "原型鍵不算 kind",
    parseEntry(JSON.stringify({ ...base, kind: "toString" })) === null &&
      parseEntry(JSON.stringify({ ...base, kind: "constructor" })) === null,
  );
  check(
    "未來版號丟棄（不硬解成錯的欄位）",
    parseEntry(JSON.stringify({ ...base, v: JOURNAL_VERSION + 1, kind: "done" })) === null,
  );
  check(
    "無版號視為當前版（首版寫出的行）",
    parseEntry(JSON.stringify({ ...base, v: undefined, kind: "done" }))?.kind === "done",
  );
}

// ---- tailEntries：只取尾端 NOTIFICATION_CAP 筆 ----

{
  const many: AppNotification[] = [];
  for (let i = 0; i < NOTIFICATION_CAP + 20; i++) {
    many.push(make({ kind: "done", text: `e${i}` }));
  }
  const tail = tailEntries(many);
  check("長度收斂到上限", tail.length === NOTIFICATION_CAP);
  check("留的是最新的", tail[tail.length - 1].text === `e${NOTIFICATION_CAP + 19}`);
  check("丟的是最舊的", tail[0].text === "e20");
  check("未超上限時原封不動", tailEntries(many.slice(0, 3)).length === 3);
}

{
  // 整條讀回路徑：一份超量日記 → 解析 → 取尾端 50。
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) lines.push(serializeEntry(make({ kind: "done", text: `j${i}` })));
  lines.splice(60, 0, "壞行"); // 中間插一行壞的
  const loaded = tailEntries(parseJournal(lines.join("\n")));
  check("超量日記讀回 50 筆", loaded.length === NOTIFICATION_CAP);
  check("讀回的最後一筆是最新事件", loaded[loaded.length - 1].text === "j119");
  check("讀回的都是已讀已解決", loaded.every((e) => e.read && e.resolved));
}

// ---- 輪替 ----

{
  check("未超標不輪替", !shouldRotate(JOURNAL_MAX_LINES, 1024));
  check("行數超標要輪替", shouldRotate(JOURNAL_MAX_LINES + 1, 1024));
  check("位元組超標要輪替（行數還很少也一樣）", shouldRotate(10, JOURNAL_MAX_BYTES + 1));
  check("位元組剛好等於上限不輪替", !shouldRotate(10, JOURNAL_MAX_BYTES));
}

{
  const lines: string[] = [];
  for (let i = 0; i < JOURNAL_MAX_LINES + 200; i++) {
    lines.push(serializeEntry(make({ kind: "done", text: `r${i}` })));
  }
  const text = rotatedText(lines);
  const kept = journalLines(text);
  check("輪替後只留尾端 1000 行", kept.length === JOURNAL_KEEP_LINES);
  check("留的是最新的行", kept[kept.length - 1] === lines[lines.length - 1]);
  check("留的第一行接在被丟掉的之後", kept[0] === lines[lines.length - JOURNAL_KEEP_LINES]);
  // Rust 的 append 直接 writeln，不會補檔尾換行：少了它輪替後第一次 append 會黏行。
  check("輪替後的內容以換行結束", text.endsWith("\n"));
  check("輪替後仍可完整解析", parseJournal(text).length === JOURNAL_KEEP_LINES);
  check("未達門檻時原樣保留", journalLines(rotatedText(lines.slice(0, 5))).length === 5);
  check("空日記輪替成空字串（不留孤零零的換行）", rotatedText([]) === "");
}

// ---- utf8Bytes：輪替的位元組估算不能用 .length ----

{
  check("ASCII 一字元一位元組", utf8Bytes("abc") === 3);
  check("中文一字元三位元組", utf8Bytes("工作階段") === 12);
  check("emoji 四位元組", utf8Bytes("🚀") === 4);
}

console.log(`\n${passed} checks passed.`);
