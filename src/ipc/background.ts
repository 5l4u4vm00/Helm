// 前端呼叫 Rust 讀背景圖的封裝層。
import { invoke } from "@tauri-apps/api/core";

/** Read an image file and get it back as a data: URL (bypasses the asset protocol / its scope). */
export function readImageDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_data_url", { path });
}
