// 用系統預設瀏覽器開啟連結的封裝層。
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";

/**
 * Open a URL in the system browser.
 *
 * Terminal output is untrusted content — an agent (or anything else writing to
 * the PTY) can emit arbitrary text — so only http/https are ever handed to the
 * opener; `file:`, custom schemes and unparseable input are dropped.
 * Failures are swallowed: browser-only `npm run dev` has no Tauri runtime, so
 * every invoke rejects there.
 */
export async function openExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  await tauriOpenUrl(url).catch(() => undefined);
}
