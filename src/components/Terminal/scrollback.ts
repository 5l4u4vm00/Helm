// Scrollback 快照：把每個 pane 的畫面內容存成純文字，重啟後重播成「靜態記錄」。
//
// 兩個關鍵設計，實作時不能改：
// 1. **抓 buffer.normal，不抓 buffer.active。** agent 執行中 active 是 alt
//    buffer —— 一張半畫好的全螢幕框、沒有捲動歷史、只有 CLI 自己能重建；存它
//    只會得到髒畫面。normal 裡是 TUI 接手前 shell 印的東西，那才是我們的。
// 2. **存純渲染文字，不用 addon-serialize。** Helm 對 OSC 9（桌面通知）、
//    OSC 52（剪貼簿）、OSC 0/2（標題）都有 live handler，重播序列化後的控制
//    序列會誤觸這些副作用。純文字一個都觸發不了。代價是還原的歷史沒有顏色 ——
//    可接受，因為那段本來就要標成靜態記錄。
//
// 本檔只放副作用（檔案讀寫、定時器、term.write）；格式、重接、裁切等純邏輯全
// 在 replay.ts，由 tests/terminal-replay.test.ts 直接測。
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  deleteAppFile,
  listAppFiles,
  readAppFileOr,
  scrollbackFileName,
  writeAppFile,
  SCROLLBACK_PREFIX,
} from "../../ipc/appStore";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { useLanguageStore } from "../../store/language";
import { t } from "../../i18n";
import {
  buildReplayText,
  buildSnapshotLines,
  fingerprintKey,
  parseSnapshot,
  relativeAge,
  resumeLabel,
  serializeSnapshot,
} from "./replay";

/** buffer.normal 的一列：邏輯行的重接（isWrapped）留給擷取端處理。 */
export interface BufferLine {
  text: string;
  wrapped: boolean;
}

/**
 * 輪詢間隔 = idle debounce 的解析度。指紋只讀三、四個數字（見
 * `fingerprintKey`），所以「每 2 秒看一眼每個 pane 有沒有動」幾乎不花錢；真正
 * 貴的文字擷取只在確定要寫出時才做一次。
 *
 * ⚠️ 絕不在輸入路徑（onData）或每個 PTY chunk 上序列化：那是 agent 全速刷畫面
 * 時每秒數十次的頻率，把 5000 列 translateToString 掛在上面等於自找卡頓。
 */
const POLL_MS = 2000;
/** 指紋連續多久沒變才算 idle（≥ 一個 poll 週期）。 */
const IDLE_MS = 2000;
/**
 * 定時 sweep：一直在輸出、永遠等不到 idle 的 pane 也要有寫出的機會，順便清掉
 * 孤兒檔。
 */
const SWEEP_MS = 15_000;

/** 每個 pane 的擷取函式（Terminal.tsx 在 term.open() 後註冊）。 */
const sources = new Map<string, () => BufferLine[]>();
/**
 * 每個 pane 的 xterm 實例。**只用來算廉價指紋** —— 指紋要的是 buffer.normal 的
 * (列數, baseY, cursorY, cursorX)，那是擷取函式（回傳文字陣列）給不了的，而
 * 「先抽文字再比」正是這裡要避免的成本。生命週期跟著 sources 走：
 * unregisterScrollbackSource 一定在 Terminal.tsx 的 term.dispose() 之前呼叫。
 */
const terms = new Map<string, XTerm>();

interface PaneWatch {
  /** 上次看到的指紋。 */
  fp: string;
  /** 指紋最後一次變化的時間（idle 判斷用）。 */
  changedAt: number;
  /** 已經寫出過的指紋（相同就不必再寫）。 */
  writtenFp?: string;
}
const watches = new Map<string, PaneWatch>();

/**
 * 已經重播過的 session（一次性守衛）。Terminal 主 effect 的 deps 含
 * cwd/shell/launchCommand，設定變更會讓整個 effect 重跑；沒有這個 Set 的話
 * 每次重跑都會把歷史再貼一次。
 */
const replayed = new Set<string>();

/**
 * 重播內容在 buffer.normal 裡佔掉的列數（= 回傳的 scan floor）。寫快照時跳過
 * 這些列，否則每次重啟都會把上次的記錄連框線一起再存一遍，一層層疊上去。
 *
 * scrollback 滿了之後開頭的列會被淘汰、絕對列號因此往下漂移，這個數字會變成
 * 高估 —— 但仍然安全：重播區塊最多 1000 列出頭，而 buffer 滿是 5000 列、快照
 * 又只留最後 1000 列，被多切掉的那一段本來就落在保留範圍之外。
 */
const replaySkip = new Map<string, number>();

/**
 * 重播這個 session 存下來的畫面，回傳 **scan floor**：重播內容之後第一列的
 * 絕對列號。Terminal 的 readBufferText 會跳過 floor 以下的列，否則第一次真實
 * 掃描會從重播的舊畫面撈出過期的審批提示 —— 症狀是「重啟後莫名跳出上次的核准
 * 請求」。沒有可重播的內容時回 0（代表沒有 floor）。
 */
export async function replayScrollback(term: XTerm, sessionId: string): Promise<number> {
  // 同步登記（不能等到 await 之後）：effect 重跑時舊的 replayScrollback 可能還
  // 在飛，晚一步寫入會用已 dispose 的舊 term 蓋掉新的。
  terms.set(sessionId, term);
  // 已經重播過 → 這個 term 是重建出來的空 buffer，沒有歷史也沒有 floor。
  replaySkip.set(sessionId, 0);
  if (replayed.has(sessionId)) return 0;
  replayed.add(sessionId);
  if (!useSettingsStore.getState().restoreScrollback) return 0;

  try {
    const text = await readAppFileOr(scrollbackFileName(sessionId), "");
    const snapshot = parseSnapshot(text);
    if (!snapshot) return 0;

    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    const label = resumeLabel(session);
    const replayText = buildReplayText({
      lines: snapshot.lines,
      header: t("terminal.replayHeader"),
      footer: footerWithAge(snapshot.savedAt),
      resumeHint: label ? t("terminal.replayResumeHint", { label }) : undefined,
    });
    if (!replayText) return 0;

    // 等 xterm 真的寫完才量 floor：write 是排隊處理的，太早讀 cursor 會量到
    // 重播開始前的位置，floor 就會落在歷史中間。
    await new Promise<void>((resolve) => term.write(replayText, resolve));

    const buf = term.buffer.active;
    const floor = buf.baseY + buf.cursorY;
    replaySkip.set(sessionId, floor);
    return floor;
  } catch {
    // 沒有 Tauri runtime、term 已被 dispose、檔案壞掉 —— 一律當成「沒有快照」。
    // 這條路必須不丟例外：Terminal.tsx 的呼叫端會把 rejection 當成 spawn 失敗。
    return 0;
  }
}

/** footer + 「多久以前」（用 Intl 依當前語言格式化，不需要新的 i18n key）。 */
function footerWithAge(savedAt: number): string {
  const footer = t("terminal.replayFooter");
  const age = relativeAge(savedAt, Date.now());
  if (!age) return footer;
  try {
    const lang = useLanguageStore.getState().name;
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    return `${footer} (${rtf.format(-age.value, age.unit)})`;
  } catch {
    return footer;
  }
}

/**
 * 註冊這個 pane 的擷取函式。pull-based 是唯一能從 React 外面讀到 xterm buffer
 * 的方式（同 Terminal.tsx 既有的 latest-ref 風格）。Terminal.tsx 只負責把
 * buffer.normal 的列交出來，行重接/裁切/上限都在本模組。
 */
export function registerScrollbackSource(
  sessionId: string,
  read: () => BufferLine[],
): void {
  sources.set(sessionId, read);
}

export function unregisterScrollbackSource(sessionId: string): void {
  sources.delete(sessionId);
  terms.delete(sessionId);
  watches.delete(sessionId);
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastSweepAt = 0;

/** 開始定期擷取並寫出（idle debounce + 定時 sweep，順便清掉孤兒檔）。 */
export function startScrollbackPersistence(): void {
  if (pollTimer !== undefined) return;
  lastSweepAt = Date.now();
  pollTimer = setInterval(tick, POLL_MS);
}

function tick(): void {
  const now = Date.now();
  const sweep = now - lastSweepAt >= SWEEP_MS;
  if (sweep) {
    lastSweepAt = now;
    void sweepOrphans();
  }
  // 關掉還原就完全不擷取（連指紋都不推進），這樣重新開啟時只要一個 poll 週期
  // 就會把當下的畫面寫出去，而不是等到 pane 剛好又有變化。
  if (!useSettingsStore.getState().restoreScrollback) return;
  for (const sessionId of sources.keys()) {
    const fp = fingerprint(sessionId);
    if (fp === null) continue;
    const watch = watches.get(sessionId);
    if (!watch) {
      watches.set(sessionId, { fp, changedAt: now });
      continue;
    }
    if (watch.fp !== fp) {
      watch.fp = fp;
      watch.changedAt = now;
      // 還在動：等它安靜下來再寫（sweep 那一輪例外，見 SWEEP_MS）。
      if (!sweep) continue;
    }
    if (watch.writtenFp === fp) continue;
    if (!sweep && now - watch.changedAt < IDLE_MS) continue;
    // 樂觀記帳：寫出是 fire-and-forget（失敗靜默），先記下來才不會在同一個
    // 指紋上重複排程。
    watch.writtenFp = fp;
    // 每個 pane 一顆 setTimeout：多 pane 時不要串成一條長任務卡住 UI。
    setTimeout(() => {
      void persistPane(sessionId);
    }, 0);
  }
}

/**
 * 廉價 dirty 指紋。刻意只讀 buffer.normal 的數字：alt screen 的重繪完全不動
 * normal，所以 agent 全速刷畫面時這裡看到的是「沒變化」—— 正確，因為那些內容
 * 本來就不存。
 *
 * 已知取捨：只在原地覆寫同一列的輸出（\r 進度條）算不出變化，就不會被寫出。
 * 為此把 cursorX 也放進指紋，剩下的漏網情形不值得用「先抽文字再比」去換。
 */
function fingerprint(sessionId: string): string | null {
  const term = terms.get(sessionId);
  if (!term) return null;
  try {
    const buf = term.buffer.normal;
    return fingerprintKey(buf.length, buf.baseY, buf.cursorY, buf.cursorX);
  } catch {
    return null;
  }
}

async function persistPane(sessionId: string): Promise<void> {
  if (!useSettingsStore.getState().restoreScrollback) return;
  const read = sources.get(sessionId);
  if (!read) return;
  let rows: BufferLine[];
  try {
    rows = read();
  } catch {
    return;
  }
  const lines = buildSnapshotLines(rows, replaySkip.get(sessionId) ?? 0);
  // 沒有新內容 → 什麼都不做，**尤其不刪檔**：重播過但還沒被用過的 pane 正是
  // 這個情形，刪掉就等於「開著不動反而弄丟歷史」。
  if (lines.length === 0) return;
  await writeAppFile(scrollbackFileName(sessionId), serializeSnapshot(lines, Date.now()));
}

/**
 * 清掉不在現有 sessions 清單裡的 scrollback 檔。session 關閉後的清理就靠這條
 * ——「關閉時刪檔」會漏掉 crash 與強制結束，用清單當唯一真相則不可能漏。
 * write_app_file 的原子替換會留下同名 .tmp，所以那也一起認。
 */
async function sweepOrphans(): Promise<void> {
  const live = new Set<string>();
  const liveIds = new Set<string>();
  for (const session of useSessionStore.getState().sessions) {
    liveIds.add(session.id);
    const name = scrollbackFileName(session.id);
    live.add(name);
    live.add(name.replace(/\.txt$/, ".tmp"));
  }
  // 同一份清單也用來修剪記憶體記帳（關掉的 pane 不會再回來）。replayed 只能在
  // 這裡清 —— 它是「同一 session 只重播一次」的守衛，effect 重跑時必須還在。
  for (const id of replayed) if (!liveIds.has(id)) replayed.delete(id);
  for (const id of replaySkip.keys()) if (!liveIds.has(id)) replaySkip.delete(id);
  const files = await listAppFiles(SCROLLBACK_PREFIX);
  await Promise.all(files.filter((name) => !live.has(name)).map((name) => deleteAppFile(name)));
}

/** 立刻寫出所有 pane（關窗前）。 */
export async function flushScrollback(): Promise<void> {
  await Promise.all([...sources.keys()].map((sessionId) => persistPane(sessionId)));
}

/** 丟掉這個 session 的快照（明確關閉 pane 時的即時清理）。 */
export async function clearScrollback(sessionId: string): Promise<void> {
  watches.delete(sessionId);
  replaySkip.delete(sessionId);
  await deleteAppFile(scrollbackFileName(sessionId));
}
