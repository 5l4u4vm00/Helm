// Scrollback 快照的純邏輯：邏輯行重接、消毒、裁切、檔案格式、重播框線。
//
// 刻意不碰 xterm / Tauri / store —— 這一層決定「存什麼、長什麼樣」，副作用
// （讀寫檔、定時器、term.write）全留在 scrollback.ts，讓格式與裁切規則能直接
// 進 node 測試。.ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。

/**
 * 檔案格式版本。**讀到不認的版本要整份丟棄**，不做部分相容 —— 快照是可重生的
 * 便利資料，硬撐著讀半懂的舊格式只會把髒畫面貼回使用者眼前。
 */
export const SNAPSHOT_VERSION = 1;

/** 檔頭魔法字串：一眼看出這是 Helm 的畫面快照，也讓亂入的檔案立刻被拒。 */
const MAGIC = "helm-scrollback";

/**
 * 每個 session 的上限（留尾：最近的畫面才是使用者要找的）。
 *
 * 字元上限與 Rust 端 `MAX_READ_BYTES`（512 KiB）搭配：128k 個字元即使全是
 * CJK（UTF-8 3 bytes）也還在讀取上限內。真的撞到上限只會讀不到而不重播，
 * 不會壞掉。
 */
export const MAX_SNAPSHOT_LINES = 1000;
export const MAX_SNAPSHOT_CHARS = 128_000;

/** buffer.normal 的一列（結構上等同 scrollback.ts 的 BufferLine，刻意不互相 import）。 */
export interface SnapshotRow {
  text: string;
  wrapped: boolean;
}

export interface ScrollbackSnapshot {
  version: number;
  /** 寫出的時間（epoch ms）；重播的 footer 用它算「多久以前」。 */
  savedAt: number;
  lines: string[];
}

/**
 * 用 `wrapped` 旗標把終端機的**物理列**重接回**邏輯行**。
 *
 * 不重接的話，還原到比上次更窄的 pane 會整片撕裂：原本被 xterm 折成兩列的一
 * 句話會被當成兩行寫回去，再被新寬度折一次，變成鋸齒狀的斷句。存邏輯行則讓
 * 重播時由新的寬度重新決定怎麼折。
 *
 * 開頭就是 wrapped 的列（前一列已被 scrollback 上限吃掉或被 skip 切掉）沒有
 * 可接的對象，只能自成一行。
 */
export function joinLogicalLines(rows: readonly SnapshotRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.wrapped && out.length > 0) out[out.length - 1] += row.text;
    else out.push(row.text);
  }
  return out;
}

/** C0 + DEL + C1 控制字元。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * 去掉 C0/C1 控制字元。兩個理由，都是必需品：
 * 1. 換行是檔案格式的列分隔符，內容裡不能有；
 * 2. 重播是裸 `term.write`，殘留的 ESC 會變成活的控制序列（Helm 對 OSC 9 /
 *    52 / 0;2 都有 live handler，那正是不用 addon-serialize 的原因）。
 */
export function sanitizeLine(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** 裁掉尾端的空白列（終端機底部的空列不是內容）。 */
export function trimTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(0, end);
}

/**
 * 套用上限，**留尾**。單一列就超過字元上限時退而留該列的尾端字元 —— 回傳空
 * 陣列會讓呼叫端以為「沒東西可存」，反而把好檔案留成過期內容。
 */
export function capTail(
  lines: readonly string[],
  maxLines = MAX_SNAPSHOT_LINES,
  maxChars = MAX_SNAPSHOT_CHARS,
): string[] {
  if (lines.length === 0) return [];
  const start = Math.max(0, lines.length - maxLines);
  const kept: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= start; i -= 1) {
    const cost = lines[i].length + 1; // 加上列分隔符
    if (chars + cost > maxChars) break;
    chars += cost;
    kept.push(lines[i]);
  }
  if (kept.length === 0) {
    const last = lines[lines.length - 1];
    return [last.slice(Math.max(0, last.length - maxChars))];
  }
  kept.reverse();
  return kept;
}

/**
 * 擷取到的物理列 → 可以寫進檔案的邏輯行。
 *
 * @param skip 跳過開頭幾列。重播過的 pane 的 buffer 前段就是上次的記錄，不跳
 *   會讓每次重啟都把歷史包一層新框線疊上去。
 */
export function buildSnapshotLines(rows: readonly SnapshotRow[], skip = 0): string[] {
  const start = Math.min(Math.max(0, Math.floor(skip)), rows.length);
  const joined = joinLogicalLines(rows.slice(start));
  const lines = capTail(trimTrailingBlank(joined.map(sanitizeLine)));
  // 第二道防線（floor 是行號、會因折行/淘汰而失準）：真的漏了框線就整份不寫。
  // 回空陣列 = persistPane 什麼都不做、**尤其不刪檔**，所以最壞情況只是這一輪
  // 沿用舊快照，而不是把髒內容固化下來讓它一層層疊。
  return hasReplayBanner(lines) ? [] : lines;
}

export function serializeSnapshot(lines: readonly string[], savedAt: number): string {
  const stamp = Number.isFinite(savedAt) ? Math.max(0, Math.floor(savedAt)) : 0;
  return `${MAGIC} ${SNAPSHOT_VERSION} ${stamp}\n${lines.join("\n")}\n`;
}

/**
 * 重播框線的識別特徵。
 *
 * 刻意**比對 Helm 自己的框線文字**，而不是「以 ── 開頭結尾」這種形狀規則：
 * 形狀規則同時會誤殺一般輸出（`──────────` 分隔線、`─── Coverage summary ───`
 * 這類第三方標題），而誤殺的代價是把使用者真正的歷史整份丟掉。
 *
 * 只收錄各語言的**不變片段**（不含 `{label}` 之類的插值與 footer 後面接的
 * 「多久以前」），所以框線被折行、後面被接上東西都仍然認得出來。新增語言時
 * 要一併補進來 —— 漏掉只會讓自癒失效，不會誤殺。
 */
const REPLAY_BANNER_MARKS = [
  // en
  "history from your last session",
  "static record above",
  "to resume",
  // zh-TW
  "上次啟動的畫面",
  "以上為靜態記錄",
  "接續",
] as const;

/**
 * 這一份快照裡是否混進了 Helm 自己的重播框線。
 *
 * 出現這種檔案代表某一輪的 scan floor 沒有蓋住整個重播區塊（歷史成因：pane 在
 * 被摺疊/隱藏的極窄寬度下重播，框線被折成兩三個物理列，floor 只算到其中一部分
 * ——`waitForWidth` 之後不再產生，但**已經寫壞的檔案還在磁碟上**）。
 *
 * 這種檔案不能照常重播：每次啟動都會把上一輪的框線連同殘缺的尾巴再存一遍，
 * 一層層疊上去，而且畫面上會出現半截的 header（例如 `ssion ──`）。
 *
 * 刻意整份丟棄而不是「濾掉框線那幾列」：框線之間夾的本來就是更早那一輪的重播
 * 內容，逐列濾除只會留下一堆錯位的殘骸；而 scrollback 是可重生的便利資料，丟掉
 * 最多損失一次歷史，下一個 poll 週期就會以乾淨的內容重寫。
 */
export function hasReplayBanner(lines: readonly string[]): boolean {
  return lines.some((line) => {
    // 框線一定同時有 ── 和其中一段固定文字。兩個條件都要，一般輸出才不會因為
    // 剛好提到 "to resume" 之類的字就被丟掉。
    if (!line.includes("──")) return false;
    return REPLAY_BANNER_MARKS.some((mark) => line.includes(mark));
  });
}

/**
 * 解析檔案內容；檔頭不對、版本不認、沒有內容、**或含有重播框線** → null
 * （整份丟棄，見 hasReplayBanner）。
 */
export function parseSnapshot(text: string): ScrollbackSnapshot | null {
  if (!text) return null;
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  const head = text.slice(0, nl).trimEnd();
  const m = /^helm-scrollback (\d+) (\d+)$/.exec(head);
  if (!m) return null;
  const version = Number(m[1]);
  if (version !== SNAPSHOT_VERSION) return null;
  const savedAt = Number(m[2]);
  const body = text.slice(nl + 1);
  const raw = body.length === 0 ? [] : body.split("\n");
  // 寫出時以換行結尾，split 因此會多出一個空字串，那不是一列。
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  // 讀進來的檔案也套上限與消毒：手動編輯或損壞的檔案不該變成一大坨重播。
  const lines = capTail(trimTrailingBlank(raw.map(sanitizeLine)));
  if (lines.length === 0) return null;
  // 自癒：舊版寫壞的檔案（含自己的重播框線）在這裡被擋下，於是下一個 poll
  // 週期就會用當下的乾淨畫面覆蓋掉它，不必手動刪檔。
  if (hasReplayBanner(lines)) return null;
  return { version, savedAt, lines };
}

export interface ReplayFrame {
  lines: readonly string[];
  header: string;
  footer: string;
  /** 有 agent 且能接續時的提示（`terminal.replayResumeHint`）。 */
  resumeHint?: string;
}

/**
 * 組出要裸寫進終端機的重播文字。
 *
 * 全部用 dim SGR：這個框是「你被還原了」的**唯一** UI（刻意不進通知中心 ——
 * 還原不是一件需要事後追溯的事件），所以視覺上必須一眼看出是靜態記錄而不是
 * 活的輸出。沒有顏色是不用 addon-serialize 的代價，也剛好強化了這個區別。
 */
export function buildReplayText(frame: ReplayFrame): string {
  if (frame.lines.length === 0) return "";
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m\r\n`;
  let out = dim(frame.header);
  for (const line of frame.lines) out += dim(line);
  out += dim(frame.footer);
  if (frame.resumeHint) out += dim(frame.resumeHint);
  return out;
}

export type AgeUnit = "minute" | "hour" | "day";

/**
 * 「多久以前」的單位換算（格式化交給呼叫端的 Intl.RelativeTimeFormat，這裡
 * 保持與語言無關）。一分鐘內、未來時間（時鐘倒退）→ null，不值得說。
 */
export function relativeAge(
  savedAt: number,
  now: number,
): { value: number; unit: AgeUnit } | null {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  const ms = now - savedAt;
  if (ms < 60_000) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { value: minutes, unit: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: "hour" };
  return { value: Math.floor(hours / 24), unit: "day" };
}

export interface ResumeCandidate {
  agentId?: string | null;
  agentLabel?: string;
  agentSessionIds?: readonly string[];
}

/**
 * 重播要不要附上「可以接續」的提示，以及提示裡的名字。
 *
 * 條件刻意嚴格：要有 agent，**而且**要有 agent 自己回報過的 session id ——
 * 沒有 id 就沒有東西可以 resume，喊了只是騙人。這也讓本支線不必 import 冷還原
 * 或 resume 那兩條線的任何東西：它們沒接上時 agentSessionIds 一定是空的，提示
 * 自動不出現。
 */
export function resumeLabel(session: ResumeCandidate | undefined | null): string | null {
  if (!session?.agentId) return null;
  if (!session.agentSessionIds || session.agentSessionIds.length === 0) return null;
  return session.agentLabel ?? session.agentId;
}

/** 廉價的 dirty 判斷指紋（不抽文字）。 */
export function fingerprintKey(
  length: number,
  baseY: number,
  cursorY: number,
  cursorX: number,
): string {
  return `${length}:${baseY}:${cursorY}:${cursorX}`;
}
