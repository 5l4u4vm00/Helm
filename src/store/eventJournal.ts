// 事件日記：把通知中心的項目 append 到磁碟，開機時讀回來。
// 目的是讓「我睡覺時 agent 做了什麼、哪一個中途死掉」跨重啟仍可回溯 ——
// 通知中心本身只在記憶體、上限 50 筆，重開就歸零。
//
// 這一層只做 I/O 協調（時機、順序、輪替、失敗容忍）；格式與驗證全在純函式的
// journalFormat.ts，所以規則都能進 node 測試。
import { JOURNAL_FILE, appendAppFile, readAppFile, writeAppFile } from "../ipc/appStore";
import { NOTIFICATION_CAP, type AppNotification } from "./notificationCenter";
import {
  journalLines,
  parseJournal,
  rotatedText,
  serializeEntry,
  shouldRotate,
  tailEntries,
  utf8Bytes,
} from "./journalFormat";

/**
 * 檔案目前的大小（載入時量測，之後每次成功 append 累加）。
 * measured=false 代表沒量過（讀取失敗、或還沒載入）—— 此時一律不輪替：輪替是
 * 「重寫成尾端 N 行」，在不知道檔案內容的情況下做它就是拿歷史去賭。
 */
let lineCount = 0;
let byteCount = 0;
let measured = false;

/**
 * 連續寫入失敗次數。純瀏覽器 `npm run dev` 下每個 invoke 都 reject，若不關掉
 * 就會每來一筆通知放一個註定失敗的 promise；連續失敗數次即視為「這個環境沒有
 * 持久化」並徹底安靜下來。成功一次就歸零（暫時性的磁碟滿不該永久關閉功能）。
 */
let failures = 0;
const MAX_FAILURES = 3;

/**
 * 寫入序列。append 與輪替共用同一條鏈：兩個 invoke 同時在飛時 Rust 端的
 * O_APPEND 不保證先後，輪替更可能把它前後的 append 蓋掉。
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  // 失敗靜默：日記是便利功能，任何一步出錯都不該冒泡成 unhandled rejection。
  queue = queue.then(task).catch(() => {});
}

/** 重寫成尾端 N 行，並重新量測。讀不回來就不動 —— 寧可讓檔案繼續長。 */
async function rotate(): Promise<void> {
  const res = await readAppFile(JOURNAL_FILE);
  if (!res.ok || res.text === null) return;
  const text = rotatedText(journalLines(res.text));
  if (!(await writeAppFile(JOURNAL_FILE, text))) return;
  lineCount = journalLines(text).length;
  byteCount = utf8Bytes(text);
}

/** 追加一筆（fire-and-forget，失敗靜默：通知不該因為寫檔失敗而消失）。 */
export function appendJournalEntry(n: AppNotification): void {
  if (failures >= MAX_FAILURES) return;
  let line: string;
  try {
    line = serializeEntry(n);
  } catch {
    return;
  }
  enqueue(async () => {
    // 再檢查一次：排隊時還沒失敗過，前面幾筆的失敗要能擋住整串後續（一次通知
    // 風暴會在任何一筆真的送出前就全部排進來）。
    if (failures >= MAX_FAILURES) return;
    if (!(await appendAppFile(JOURNAL_FILE, line))) {
      failures += 1;
      return;
    }
    failures = 0;
    lineCount += 1;
    byteCount += utf8Bytes(line) + 1; // +1 = Rust 端補上的換行
    if (measured && shouldRotate(lineCount, byteCount)) await rotate();
  });
}

/** 開機時讀回歷史（已標成 resolved + read，數量受 NOTIFICATION_CAP 約束）。 */
export async function loadJournalEntries(): Promise<AppNotification[]> {
  const res = await readAppFile(JOURNAL_FILE);
  // ok:false = 沒有 Tauri runtime（瀏覽器 dev / Playwright）或讀取失敗。兩者都
  // 只是「這次沒有歷史」，不動檔案。
  if (!res.ok) return [];
  // 讀得動就證明有 runtime：把寫入失敗計數歸零，讓上一輪的暫時性失敗不會把
  // 這次啟動也一起關掉。
  failures = 0;
  lineCount = res.text === null ? 0 : journalLines(res.text).length;
  byteCount = res.text === null ? 0 : utf8Bytes(res.text);
  measured = true;
  if (res.text === null) return [];

  // 輪替排進寫入序列（不擋 bootstrap：使用者不必為了看歷史等一次重寫）。
  if (shouldRotate(lineCount, byteCount)) enqueue(rotate);

  return tailEntries(parseJournal(res.text), NOTIFICATION_CAP);
}
