// 終端 renderer 的掛載與重繪（從 Terminal.tsx 抽出）。
//
// 現況：xterm 5.x + canvas addon，落回 xterm 內建 DOM renderer。
//
// W-08 評估 WebGL 的結論：**維持 canvas**。理由依重要性排序：
// 1. Helm 的架構是「一個 session 一個 xterm，而且全部同時掛著」（隱藏的 pane 只是
//    display:none，見 App.css），改用 WebGL 等於「每個 pane 一個 WebGL2 context」。
//    瀏覽器對同時存活的 WebGL context 有硬上限（WebKit / Chromium 都在十幾個的量
//    級，超過就丟掉最舊的 context 並派送 contextlost），而這個 app 的正常用法本來
//    就是十幾條 session —— 結果會是 context 一直被回收、一直落回 canvas，白付
//    renderer 重建與 glyph atlas 重建的成本。canvas 2D 沒有這種 per-page 上限。
// 2. 隱藏的 pane 是 0×0 canvas。WebGL renderer 在重新顯示後要可靠重繪，需要把
//    attach/detach 綁到 visible 旗標上（xterm.js 已知問題），那段程式在
//    Terminal.tsx；canvas 與 DOM renderer 都不需要（見該檔 visible effect 的註解）。
// 3. 對輸入延遲沒有好處：renderer 根本不在 keydown → onData → ptyWrite 這條路徑上
//    （已逐段審計：capture 階段的 prefix 判斷全是 O(1) 比較，onData 只有一個訂閱者
//    直接呼叫 ptyWrite，中間沒有 serialize / scan / regex），它只影響輸出的繪製。
// 4. macOS WKWebView 是 macOS 上唯一的引擎，而「全螢幕 TUI 畫成全白」這類失效是
//    靜默的 —— 下面的 try/catch 落回鏈救不了它（只擋得住 throw）。要把預設換成
//    WebGL，前提是先在 `npm run tauri dev` 下實測 nvim/vim 全螢幕與 agent 的
//    alt-screen 切換沒有白屏；本次評估的環境看不到畫面，沒有這項實測就不該換。
//
// 之後若要重評 WebGL，兩件事已經先查清楚（省下重查的功夫）：
// - `repaintAfterFontChange` 不必改。term.clearTextureAtlas() 會經 RenderService
//   轉給「當下這個」renderer，WebglRenderer 的實作是清掉 atlas texture、清 glyph
//   model 再重畫可見區，與 canvas 版語意等價。
// - context loss 的處理就是下面這條同一條路：dispose addon → xterm 自動 setRenderer
//   回內建 DOM renderer（canvas 與 webgl addon 的 dispose 都會這樣做），差別只在
//   WebGL 要訂閱 addon.onContextLoss，canvas 2D 要聽 DOM 的 contextlost 事件。
import { CanvasAddon } from "@xterm/addon-canvas";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

export interface RendererHandle {
  dispose(): void;
}

/** addon 可能已隨 terminal 一起被 dispose，或根本沒掛成功。 */
function disposeQuietly(addon: CanvasAddon | undefined): void {
  try {
    addon?.dispose();
  } catch {
    /* already disposed with the terminal */
  }
}

/**
 * 必須在 term.open(container) 之後呼叫。
 *
 * 落回鏈是硬鏈，沒有設定開關：
 * - CanvasAddon 掛不上（建構或 activate throw）→ 沿用 xterm 內建 DOM renderer。
 * - 掛上之後 2D context 被系統收回（GPU process 重啟、記憶體壓力）→ dispose addon，
 *   xterm 會把 renderer 換回內建 DOM 版，這個 pane 繼續更新。canvas addon 自己完全
 *   沒處理 contextlost，少了這段的症狀是「某個 pane 從此不再重繪」。
 *   contextlost 不 bubble，所以 listener 掛在 term.element 的 **capture** 階段
 *   （非 bubbling 的事件一樣會經過 capture 階段往下傳到 target）。
 *   刻意不 preventDefault：那是「請瀏覽器嘗試還原」的意思，但 canvas addon 不聽
 *   contextrestored，還原後的 layer 仍是空的；落回 DOM renderer 才是確定會動的路。
 */
export function attachRenderer(term: XTerm): RendererHandle {
  let addon: CanvasAddon | undefined;
  try {
    addon = new CanvasAddon();
    term.loadAddon(addon);
  } catch {
    disposeQuietly(addon);
    return { dispose: () => {} };
  }

  const element = term.element;
  const onContextLost = () => {
    element?.removeEventListener("contextlost", onContextLost, true);
    disposeQuietly(addon);
    addon = undefined;
    // 內建 DOM renderer 從零開始，需要一次完整重畫才會有內容。
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      /* terminal already disposed */
    }
  };
  element?.addEventListener("contextlost", onContextLost, true);

  return {
    dispose: () => {
      element?.removeEventListener("contextlost", onContextLost, true);
      disposeQuietly(addon);
      addon = undefined;
    },
  };
}

/**
 * 字型載入完成或字型設定變更後的重繪。
 *
 * 為什麼三件事要一起做：canvas renderer 在 open 時就建好 glyph atlas，只改
 * fontFamily（同尺寸）時 cols/rows 不變 → fit() 是 no-op，舊 glyph 會留在畫面上
 * （macOS 上的症狀是「選了字型但畫面沒變」）。所以先丟掉 atlas、再 fit（字級變化
 * 會改 cell 尺寸，任何格子變化都會經 onResize 傳到 PTY）、最後強制重畫可見列。
 *
 * 三件事對每一種 renderer 都成立：clearTextureAtlas 是轉給當下的 renderer（內建
 * DOM renderer 沒有 atlas，那一步就是 no-op），refresh 才是真正逼出畫面的那步。
 *
 * fit() 只在 pane 真的有尺寸時做：隱藏的 pane（data-in-layout="false" →
 * display:none）容器是 0×0，此時 fit() 會把格子夾成 9×5 之類的最小值，而還原重播
 * 的裸 write 會把該寬度的斷行永久烙進 buffer（見 Terminal.tsx 的重播段落）。
 * 0 尺寸時保留現有格子，等 pane 顯示出來由 ResizeObserver 補 fit。
 */
export function repaintAfterFontChange(term: XTerm, fit: FitAddon): void {
  try {
    term.clearTextureAtlas();
    if (hasSize(term)) fit.fit();
    term.refresh(0, term.rows - 1);
  } catch {
    /* ignore */
  }
}

/** pane 是否有可量測的尺寸（0×0 = 隱藏或尚未版面配置）。讀不到就當成有尺寸，
 * 維持修正前的行為 —— 這道防護是為了擋 0 尺寸，不該自己變成新的失敗點。 */
function hasSize(term: XTerm): boolean {
  try {
    const el = term.element?.parentElement ?? term.element;
    if (!el) return true;
    return el.clientWidth > 0 && el.clientHeight > 0;
  } catch {
    return true;
  }
}
