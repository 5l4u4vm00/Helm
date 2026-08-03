// 事件日記的磁碟格式：一行一筆通知的 JSONL（純函式，無執行期 import，node
// 測試可直接載入）。
//
// 為什麼是 JSONL 而不是一份 JSON 陣列：日記是 append-only 的熱路徑（每次通知
// 都寫），整份重寫會把「寫檔失敗」的風險從「掉一筆」放大成「掉全部」。代價
// 是必須逐行解析，而壞掉的一行只丟那一行 —— 這正是想要的行為：日記的價值在
// 於「我睡覺時發生了什麼」，為了一行截斷的尾巴丟掉整晚的歷史毫無道理。
//
// 相容性策略：帶 `v` 版號，版號不認識就丟那一行（而不是硬解成錯的欄位）。
import {
  NOTIFICATION_CAP,
  type AppNotification,
  type NotifyKind,
} from "./notificationCenter.ts";

/** 目前的行格式版本。改欄位語意時 +1，舊行會被當成不認識而丟棄。 */
export const JOURNAL_VERSION = 1;

/**
 * 輪替門檻（行數）。超過就重寫成尾端 JOURNAL_KEEP_LINES 行。
 * 通知中心只顯示 NOTIFICATION_CAP 筆，留 1000 行是給「往前多翻一點」的餘裕。
 */
export const JOURNAL_MAX_LINES = 5000;
export const JOURNAL_KEEP_LINES = 1000;

/**
 * 輪替門檻（位元組）。行數之外還看大小，因為 Rust 端 read_app_file 有 512KB
 * 單檔上限，超過就整份讀不回來（三態的 ok:false）—— 那會讓日記變成一個永遠
 * 讀不到又永遠繼續長的死檔。留餘裕在上限之下先輪替。
 */
export const JOURNAL_MAX_BYTES = 384 * 1024;

/** 單行內各文字欄位的上限：一筆病態的長提示不該撐爆整份日記。 */
const TITLE_MAX = 120;
const LABEL_MAX = 60;
/** 與 hookEvents / engine 的提示長度上限一致。 */
const TEXT_MAX = 200;

/**
 * 已知的 kind。型別是 Record<NotifyKind, true>，所以 NotifyKind 新增成員時這
 * 裡會編譯失敗 —— 漏列的下場是那種事件的歷史被靜默丟棄，不能靠人記得補。
 */
const KNOWN_KINDS: Record<NotifyKind, true> = {
  approval: true,
  question: true,
  plan: true,
  done: true,
  error: true,
  interrupted: true,
  stalled: true,
};

function isKnownKind(kind: string): kind is NotifyKind {
  // hasOwnProperty 而非 `in`：後者會讓 "toString" 這種原型鍵通過。
  return Object.prototype.hasOwnProperty.call(KNOWN_KINDS, kind);
}

const encoder = new TextEncoder();

/** 文字的 UTF-8 位元組數（輪替判斷用；.length 是 UTF-16 碼元，中日文會低估三倍）。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 序列化一筆通知成一行（不含換行；Rust 端的 append 會補）。
 *
 * 刻意不寫 read / resolved：讀回來的歷史一律視為已讀已解決（見 parseEntry），
 * 存了也只會被覆蓋。JSON.stringify 會把換行轉義成 \n，所以帶多行內文的提示
 * 不可能破壞「一行一筆」的不變量。
 */
export function serializeEntry(n: AppNotification): string {
  const rec: Record<string, unknown> = {
    v: JOURNAL_VERSION,
    id: n.id,
    kind: n.kind,
    sessionId: n.sessionId,
    sessionTitle: clamp(n.sessionTitle, TITLE_MAX),
    createdAt: Math.round(n.createdAt),
  };
  if (n.agentLabel) rec.agentLabel = clamp(n.agentLabel, LABEL_MAX);
  if (n.text) rec.text = clamp(n.text, TEXT_MAX);
  return JSON.stringify(rec);
}

function optionalString(value: unknown, max: number): { ok: true; value?: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const text = clamp(value, max);
  return text ? { ok: true, value: text } : { ok: true };
}

/**
 * 解析一行；壞行回 null（呼叫端只丟這一行）。逐欄檢查 typeof 而非信任
 * JSON.parse 的結果 —— 手動編輯過或被別的程式寫進去的行必須擋在 store 之外，
 * 否則 undefined 會一路漏到渲染層。
 */
export function parseEntry(line: string): AppNotification | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== undefined && rec.v !== JOURNAL_VERSION) return null;

  const { id, kind, sessionId, sessionTitle, createdAt } = rec;
  if (typeof id !== "string" || !id) return null;
  if (typeof kind !== "string" || !isKnownKind(kind)) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof sessionTitle !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;

  const agentLabel = optionalString(rec.agentLabel, LABEL_MAX);
  const text = optionalString(rec.text, TEXT_MAX);
  if (!agentLabel.ok || !text.ok) return null;

  return {
    id,
    kind,
    sessionId,
    sessionTitle: clamp(sessionTitle, TITLE_MAX),
    ...(agentLabel.value === undefined ? {} : { agentLabel: agentLabel.value }),
    ...(text.value === undefined ? {} : { text: text.value }),
    createdAt,
    // 歷史一律已讀 + 已解決：開機時不該是一整排未讀紅點，也不該有「還在等你
    // 回答」的殘留 —— 那個提示所屬的 PTY 早就不在了。
    read: true,
    resolved: true,
  };
}

/** 非空行（輪替算行數與解析共用同一套切分規則）。 */
export function journalLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** 解析整份日記，壞行丟棄。順序即 append 順序（尾端最新）。 */
export function parseJournal(text: string): AppNotification[] {
  const out: AppNotification[] = [];
  for (const line of journalLines(text)) {
    const entry = parseEntry(line);
    if (entry) out.push(entry);
  }
  return out;
}

/** 只保留最新的幾筆（通知中心的上限）。 */
export function tailEntries(
  entries: AppNotification[],
  cap = NOTIFICATION_CAP,
): AppNotification[] {
  return entries.length > cap ? entries.slice(entries.length - cap) : entries;
}

/** 該輪替了嗎（行數或位元組任一超標）。 */
export function shouldRotate(lineCount: number, byteLength: number): boolean {
  return lineCount > JOURNAL_MAX_LINES || byteLength > JOURNAL_MAX_BYTES;
}

/**
 * 輪替後的完整檔案內容（尾端 JOURNAL_KEEP_LINES 行）。
 *
 * 結尾必須有換行：Rust 的 append_app_file 直接 writeln 一行，不會檢查檔案是否
 * 以換行結束 —— 少了它，輪替後的第一次 append 會黏在最後一行後面，同時毀掉
 * 兩筆。
 */
export function rotatedText(lines: string[]): string {
  const kept =
    lines.length > JOURNAL_KEEP_LINES ? lines.slice(lines.length - JOURNAL_KEEP_LINES) : lines;
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}
