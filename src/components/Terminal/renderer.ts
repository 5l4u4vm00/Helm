// 終端 renderer 的掛載與重繪（從 Terminal.tsx 抽出）。
//
// 現況：xterm 5.x + canvas addon（落回內建 DOM renderer）。xterm 6.x 在 macOS
// WKWebView 上把全螢幕 TUI（nvim 的 alternate screen）畫成全白，不論 WebGL/DOM
// renderer 或強制重繪都一樣，所以 5.x + canvas 是 WKWebView 實測可行的組合。
//
// W-08 perf/terminal-renderer 會在此評估改用 WebGL：必須做成鏈式落回、處理
// context loss（因此本函式回傳 disposer），並實測 nvim 全螢幕與 Claude Code 的
// alt-screen 沒有白屏 —— 若重現白屏，結論就是保留 canvas。
import { CanvasAddon } from "@xterm/addon-canvas";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

export interface RendererHandle {
  dispose(): void;
}

/** 必須在 term.open(container) 之後呼叫。loadAddon 拋錯時沿用內建 DOM renderer。 */
export function attachRenderer(term: XTerm): RendererHandle {
  try {
    const addon = new CanvasAddon();
    term.loadAddon(addon);
    return {
      dispose: () => {
        try {
          addon.dispose();
        } catch {
          /* already disposed with the terminal */
        }
      },
    };
  } catch {
    return { dispose: () => {} };
  }
}

/**
 * 字型載入完成或字型設定變更後的重繪。
 *
 * 為什麼三件事要一起做：canvas renderer 在 open 時就建好 glyph atlas，只改
 * fontFamily（同尺寸）時 cols/rows 不變 → fit() 是 no-op，舊 glyph 會留在畫面上
 * （macOS 上的症狀是「選了字型但畫面沒變」）。所以先丟掉 atlas、再 fit（字級變化
 * 會改 cell 尺寸，任何格子變化都會經 onResize 傳到 PTY）、最後強制重畫可見列。
 */
export function repaintAfterFontChange(term: XTerm, fit: FitAddon): void {
  try {
    term.clearTextureAtlas();
    fit.fit();
    term.refresh(0, term.rows - 1);
  } catch {
    /* ignore */
  }
}
