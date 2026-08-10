// OS 檔案拖放事件的訂閱封裝。
//
// 為什麼是 Tauri 事件而不是 HTML5 的 drop handler：Tauri 2 在 Windows 上
// `dragDropEnabled` 預設為 true，原生 WebView2 層會攔截 OS 的拖放並轉成自己的
// 事件，**同時不再送出 HTML5 的 drop 事件**。所以 `onDrop` 在 Windows 上永遠不會
// 觸發，這條路是唯一可行的。
//
// ⚠️ 相依：若日後有人把 tauri.conf.json 的 `app.windows[].dragDropEnabled` 設成
// false，這個事件就不再發出，終端機拖放會整個失效（HTML5 drop 會回來，但那條路
// 拿不到真實檔案路徑）。維持預設即可，不需要在設定檔寫明。
//
// sidebar 把 session 拖到別的 workspace 走的是 webview 內部的 HTML5 DnD，
// 不經過 OS 拖放層，不受這裡影響。
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** 一次拖放：落下的檔案絕對路徑 + 視窗座標下的落點。 */
export interface FileDropEvent {
  paths: string[];
  x: number;
  y: number;
}

/**
 * 訂閱檔案落下事件（只有 "drop" 這個階段，hover/cancel 不轉發）。
 *
 * 沒有 Tauri runtime 時（瀏覽器 `npm run dev` / Playwright）`getCurrentWebview`
 * 會**同步 throw**而不是回傳 rejected promise，所以這裡 try/catch 成 no-op
 * unlisten —— 少了它，App 的 effect 會在掛載時整個炸掉。
 */
export function onFileDrop(handler: (event: FileDropEvent) => void): Promise<UnlistenFn> {
  try {
    return getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type !== "drop") return;
      const position = payload.position;
      handler({
        paths: payload.paths,
        // position 是 PhysicalPosition（實體像素，含 DPI 縮放）；要跟
        // getBoundingClientRect 的 CSS 像素比對就得先換算。Windows 上 125%/150%
        // 顯示縮放很常見，少了這步在高 DPI 螢幕會命中錯的 pane。
        //
        // 用 devicePixelRatio 而非 Tauri 的 `position.toLogical(factor)`：後者的
        // factor 要 await `scaleFactor()`，在事件處理器裡引入非同步等待，落點就
        // 可能與當下佈局錯開。webview 裡 devicePixelRatio 就是同一個 scale
        // factor，而且同步可讀。
        x: position.x / window.devicePixelRatio,
        y: position.y / window.devicePixelRatio,
      });
    });
  } catch {
    return Promise.resolve(() => {});
  }
}
