// 前端呼叫 Rust 狀態檔讀寫的封裝層（見 src-tauri/src/appstore.rs）。
// 檔名常數集中在此，讓 sessionSnapshot / scrollback / eventJournal 三方共用同
// 一組命名，不必互相 import。
import { invoke } from "@tauri-apps/api/core";

/** session 清單 + 分割佈局的快照（原子替換）。 */
export const SNAPSHOT_FILE = "sessions.json";
/** 每個 pane 一個 scrollback 檔：一個 pane 重寫只影響自己，壞檔只損失一個 pane。 */
export const SCROLLBACK_PREFIX = "scrollback-";
/** 通知/事件日記（append-only JSONL）。 */
export const JOURNAL_FILE = "events.jsonl";

export function scrollbackFileName(sessionId: string): string {
  // session id 是 crypto.randomUUID()，本來就只有 hex 與 '-'；仍過一次濾網，
  // 免得日後有人塞非 UUID 進來撞到 Rust 端的檔名白名單。
  return `${SCROLLBACK_PREFIX}${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.txt`;
}

/**
 * 讀檔的三態結果。「不存在」與「讀取失敗」不能塌成同一個值：一次暫時性的
 * 讀取失敗若被當成「沒有快照」，接著就會用一份空快照蓋掉好的檔案。
 */
export type AppFileRead = { ok: true; text: string | null } | { ok: false };

export async function readAppFile(name: string): Promise<AppFileRead> {
  try {
    const text = await invoke<string | null>("read_app_file", { name });
    return { ok: true, text: text ?? null };
  } catch {
    // 沒有 Tauri runtime（瀏覽器 npm run dev / Playwright）也走這裡：呼叫端
    // 因此會停用寫入，行為與沒有持久化的舊版完全相同。
    return { ok: false };
  }
}

/** 便利版：讀不到就當空內容（scrollback 這類「沒有就不重播」的資料）。 */
export function readAppFileOr(name: string, fallback = ""): Promise<string> {
  return invoke<string | null>("read_app_file", { name })
    .then((text) => text ?? fallback)
    .catch(() => fallback);
}

/** 寫入失敗靜默：持久化是便利功能，硬碟滿了不該讓 app 退化。 */
export function writeAppFile(name: string, contents: string): Promise<boolean> {
  return invoke<void>("write_app_file", { name, contents })
    .then(() => true)
    .catch(() => false);
}

export function appendAppFile(name: string, line: string): Promise<boolean> {
  return invoke<void>("append_app_file", { name, line })
    .then(() => true)
    .catch(() => false);
}

export function deleteAppFile(name: string): Promise<boolean> {
  return invoke<void>("delete_app_file", { name })
    .then(() => true)
    .catch(() => false);
}

export function listAppFiles(prefix: string): Promise<string[]> {
  return invoke<string[]>("list_app_files", { prefix }).catch(() => []);
}

/**
 * 「忘記已保存的工作階段」：刪掉快照、所有 scrollback 與事件日記。
 * 只影響下次啟動 —— 目前執行中的 session 一律不動。
 */
export async function forgetPersistedState(): Promise<void> {
  const scrollbacks = await listAppFiles(SCROLLBACK_PREFIX);
  await Promise.all([
    deleteAppFile(SNAPSHOT_FILE),
    deleteAppFile(JOURNAL_FILE),
    ...scrollbacks.map((name) => deleteAppFile(name)),
  ]);
}
