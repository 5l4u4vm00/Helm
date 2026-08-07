// 「在資料夾開啟 Helm」的前端封裝（見 src-tauri/src/launch.rs）。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 本次啟動指定要開的資料夾（`helm .`、檔案總管右鍵），沒有則 null。
 * Rust 端取後即清空，所以只有第一次呼叫拿得到。
 * 失敗一律當作沒有：瀏覽器模式（`npm run dev`）沒有 Tauri runtime。
 */
export function getLaunchFolder(): Promise<string | null> {
  return invoke<string | null>("launch_folder")
    .then((f) => f ?? null)
    .catch(() => null);
}

/** App 已在執行時又從資料夾啟動一次：Rust 把路徑轉進來（single-instance）。 */
export function onOpenFolder(handler: (folder: string) => void): Promise<UnlistenFn> {
  return listen<string>("app://open-folder", (e) => handler(e.payload)).catch(
    () => () => {},
  );
}
