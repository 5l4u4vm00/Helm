// 前端呼叫 Rust 路徑探測的封裝層。
import { invoke } from "@tauri-apps/api/core";

/** Whether a path is currently a readable directory. Fails open: a rejection
 *  means "no Tauri runtime" (browser-only `npm run dev`, Playwright), and a
 *  false warning about every folder would be worse than none. */
export function dirExists(path: string): Promise<boolean> {
  return invoke<boolean>("dir_exists", { path }).catch(() => true);
}
