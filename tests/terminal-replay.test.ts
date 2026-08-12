// 畫面快照的純邏輯測試：邏輯行重接、消毒、裁切（留尾）、重播框線、
// 「多久以前」與 resume 提示的條件（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/terminal-replay.test.ts
import assert from "node:assert";
import {
  buildReplayText,
  buildSnapshotLines,
  hasReplayBanner,
  parseSnapshot,
  capTail,
  joinLogicalLines,
  MAX_SNAPSHOT_CHARS,
  MAX_SNAPSHOT_LINES,
  relativeAge,
  resumeLabel,
  sanitizeLine,
  trimTrailingBlank,
  type SnapshotRow,
} from "../src/components/Terminal/replay.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

/** 方便寫測資：`row("abc")` 是新行，`wrap("def")` 是上一列的續行。 */
function row(text: string): SnapshotRow {
  return { text, wrapped: false };
}
function wrap(text: string): SnapshotRow {
  return { text, wrapped: true };
}

// ---- 邏輯行重接（不接就會在較窄的 pane 撕裂） ----

check(
  "沒有 wrapped 旗標時原樣輸出",
  JSON.stringify(joinLogicalLines([row("a"), row("b")])) === '["a","b"]',
);
check(
  "wrapped 的續行接回上一列",
  JSON.stringify(joinLogicalLines([row("hello "), wrap("world")])) === '["hello world"]',
);
check(
  "連續多段 wrapped 全接成一行",
  JSON.stringify(joinLogicalLines([row("a"), wrap("b"), wrap("c"), row("d")])) ===
    '["abc","d"]',
);
check(
  "開頭就是 wrapped（前一列已被淘汰）→ 自成一行，不丟內容",
  JSON.stringify(joinLogicalLines([wrap("tail"), row("next")])) === '["tail","next"]',
);
check("空輸入 → 空陣列", joinLogicalLines([]).length === 0);

// ---- 消毒：換行是列分隔符，ESC 重播會變成活的控制序列 ----

check("換行被拿掉（否則會破壞檔案格式）", sanitizeLine("a\nb\r\nc") === "abc");
check("ESC 被拿掉（否則裸寫會誤觸 OSC handler）", sanitizeLine("\x1b]9;boom\x07x") === "]9;boomx");
check("一般文字與中日韓字元不受影響", sanitizeLine("路徑 ok ✳") === "路徑 ok ✳");

// ---- 尾端空白列 ----

check(
  "尾端空白列被裁掉",
  JSON.stringify(trimTrailingBlank(["a", "", "   ", ""])) === '["a"]',
);
check(
  "中間的空白列保留（那是內容的一部分）",
  JSON.stringify(trimTrailingBlank(["a", "", "b"])) === '["a","","b"]',
);
check("全空白 → 空陣列", trimTrailingBlank(["", "  "]).length === 0);

// ---- 上限：留尾 ----

check(
  "超過列數上限時留最後幾列",
  JSON.stringify(capTail(["1", "2", "3", "4"], 2, 1000)) === '["3","4"]',
);
check(
  "沒超過上限時原樣保留",
  JSON.stringify(capTail(["1", "2"], 10, 1000)) === '["1","2"]',
);
check(
  "字元上限也是留尾（先丟舊的）",
  // 每列 3 字元 + 1 個列分隔符 = 4；上限 9 只裝得下兩列。
  JSON.stringify(capTail(["aaa", "bbb", "ccc"], 100, 9)) === '["bbb","ccc"]',
);
check(
  "單一列就超過字元上限 → 留該列尾端，不回空陣列",
  JSON.stringify(capTail(["x".repeat(10)], 100, 4)) === '["xxxx"]',
);
check("空輸入 → 空陣列", capTail([], 10, 10).length === 0);
check("預設上限是 1000 行 / 128000 字", MAX_SNAPSHOT_LINES === 1000 && MAX_SNAPSHOT_CHARS === 128_000);

// ---- buildSnapshotLines：重接 → 消毒 → 裁尾 → 上限 ----

check(
  "整條流水線：重接續行並裁掉尾端空列",
  JSON.stringify(buildSnapshotLines([row("he"), wrap("llo"), row(""), row("  ")])) ===
    '["hello"]',
);
check(
  "skip 跳過重播區塊（避免歷史一層層疊起來）",
  JSON.stringify(buildSnapshotLines([row("old1"), row("old2"), row("new")], 2)) ===
    '["new"]',
);
check(
  "skip 大於實際列數 → 空陣列（呼叫端據此不寫檔）",
  buildSnapshotLines([row("a")], 99).length === 0,
);
check(
  "skip 切斷 wrapped 的頭 → 續行自成一行，不接到別人身上",
  JSON.stringify(buildSnapshotLines([row("head"), wrap("tail")], 1)) === '["tail"]',
);
check("負的 skip 當成 0", JSON.stringify(buildSnapshotLines([row("a")], -5)) === '["a"]');

// ---- 重播框線污染的自癒（floor 漏掉框線時的第二道防線） ----
//
// 真實案例（使用者的 com.arieschao.helm/scrollback-*.txt）：pane 在被摺疊的
// 極窄寬度（實測 14 或 28 欄）下重播，36 字的 header 被折成 2～3 個物理列，
// floor 只算到其中一部分，於是殘缺的尾巴 `ssion ──` 連同 footer / resumeHint
// 一起被存回檔案，每次重開再疊一層。

check("認得出 header 框線（en）", hasReplayBanner(["── history from your last session ──"]));
check("認得出 header 框線（zh-TW）", hasReplayBanner(["── 上次啟動的畫面 ──"]));
check("認得出 footer 框線（zh-TW）", hasReplayBanner(["── 以上為靜態記錄，shell 是新開的 ──"]));
check("認得出 resume 提示框線", hasReplayBanner(["── press Ctrl+A R to resume Claude Code ──"]));
// footer 後面會被 footerWithAge 接上「多久以前」，所以不能用行尾錨點比對。
check(
  "footer 後面接了「多久以前」仍認得",
  hasReplayBanner(["── static record above; the shell below is new ── (yesterday)"]),
);

// 誤殺一般輸出的代價是「把使用者真正的歷史整份丟掉」，比漏抓嚴重得多，
// 所以判定要同時滿足「有 ──」與「含 Helm 自己的框線文字」兩個條件。
check("純分隔線不算（很多 CLI 都會印）", !hasReplayBanner(["──────────"]));
check("第三方標題不算", !hasReplayBanner(["─── Coverage summary ───"]));
check("框線形狀的第三方輸出不算", !hasReplayBanner(["── build finished ──"]));
check("有關鍵字但沒有 ── 不算", !hasReplayBanner(["Press enter to resume the download"]));
check("一般輸出不會被誤判", !hasReplayBanner(["PS C:\\Users\\USER> npm test", "ok - 1"]));
// 折斷的殘骸單看不算 —— 不影響自癒：同一份檔案裡完整的 footer/resumeHint
// 一定會被認出來，整份丟棄後殘骸也跟著沒了。
check("折斷的殘骸單看不算（避免誤殺一般輸出）", !hasReplayBanner(["ssion ──"]));
check("空清單不算", !hasReplayBanner([]));

// 寫入路徑：漏網的框線 → 整份不寫（回空陣列，persistPane 據此不動檔案）
check(
  "buildSnapshotLines 偵測到框線就整份不寫",
  buildSnapshotLines([row("── 上次啟動的畫面 ──"), row("PS C:\\x>")]).length === 0,
);

// 讀取路徑：舊版寫壞的檔案 → 整份丟棄，下個 poll 週期自動以乾淨畫面覆蓋
{
  const dirty =
    "helm-scrollback 1 1786516126380\n" +
    "ssion ──\n" +
    "PS C:\\Users\\USER\\Desktop\\richi\\Helm> \n" +
    "── static record above; the shell below is new ── (yesterday)\n" +
    "── press Ctrl+A R to resume Claude Code ──\n" +
    "PS C:\\Users\\USER\\Desktop\\richi\\Helm> \n";
  check("含重播框線的舊檔整份丟棄（自癒）", parseSnapshot(dirty) === null);

  const clean =
    "helm-scrollback 1 1786516126380\nPS C:\\x> npm test\nok - 1\n";
  const parsed = parseSnapshot(clean);
  check("乾淨的檔案照常解析", parsed !== null && parsed.lines.length === 2);
  check("解析保留 savedAt", parsed?.savedAt === 1786516126380);
  check("檔頭不對 → null", parseSnapshot("not-helm 1 0\nx\n") === null);
  check("版本不認 → null", parseSnapshot("helm-scrollback 99 0\nx\n") === null);
}

// ---- 重播框線 ----

const framed = buildReplayText({
  lines: ["one", "two"],
  header: "H",
  footer: "F",
});
check("框線順序是 header → 內容 → footer", /H[\s\S]*one[\s\S]*two[\s\S]*F/.test(framed));
check("每一列都是 dim SGR（明確標成靜態記錄）", framed.split("\x1b[2m").length === 5);
check("換行用 CRLF（終端機需要 CR）", framed.endsWith("\r\n") && !/[^\r]\n/.test(framed));
check("沒有 resume 提示時不出現第五行", !framed.includes("R:"));
check(
  "有 resume 提示時附在 footer 之後",
  buildReplayText({ lines: ["x"], header: "H", footer: "F", resumeHint: "R:claude" }).indexOf(
    "R:claude",
  ) > buildReplayText({ lines: ["x"], header: "H", footer: "F", resumeHint: "R:claude" }).indexOf("F"),
);
check(
  "沒有內容 → 空字串（連框線都不畫）",
  buildReplayText({ lines: [], header: "H", footer: "F" }) === "",
);

// ---- 「多久以前」 ----

const t0 = 1_700_000_000_000;
check("一分鐘內 → null（不值得說）", relativeAge(t0, t0 + 59_000) === null);
check(
  "5 分鐘",
  JSON.stringify(relativeAge(t0, t0 + 5 * 60_000)) === '{"value":5,"unit":"minute"}',
);
check(
  "3 小時",
  JSON.stringify(relativeAge(t0, t0 + 3 * 3_600_000)) === '{"value":3,"unit":"hour"}',
);
check(
  "2 天",
  JSON.stringify(relativeAge(t0, t0 + 2 * 86_400_000)) === '{"value":2,"unit":"day"}',
);
check("未來時間（時鐘倒退）→ null", relativeAge(t0 + 60_000, t0) === null);
check("savedAt 無效 → null", relativeAge(0, t0) === null && relativeAge(NaN, t0) === null);

// ---- resume 提示的條件 ----

check("沒有 session → null", resumeLabel(undefined) === null);
check("沒有 agent → null", resumeLabel({ agentSessionIds: ["s1"] }) === null);
check(
  "有 agent 但沒有 agent session id → null（沒東西可接續，喊了只是騙人）",
  resumeLabel({ agentId: "claude-code", agentSessionIds: [] }) === null,
);
check(
  "有 agent 且有 id → 用 agentLabel",
  resumeLabel({ agentId: "claude-code", agentLabel: "Claude Code", agentSessionIds: ["s1"] }) ===
    "Claude Code",
);
check(
  "沒有 agentLabel 時退回 agentId",
  resumeLabel({ agentId: "codex", agentSessionIds: ["s1"] }) === "codex",
);

console.log(`\n${passed} checks passed`);
