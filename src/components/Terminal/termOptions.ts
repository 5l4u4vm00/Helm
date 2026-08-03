// xterm 建構選項（從 Terminal.tsx 抽出，讓 renderer/scrollback 相關調整不必碰
// 那個檔案）。
import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { withSymbolsFallback } from "../../store/fontFamily";
import type { CursorStyle } from "../../store/settings";

/**
 * 保留的捲動歷史列數。xterm 預設 1000；agent session 動輒刷掉幾百列，1000 列
 * 常常連這一輪都裝不下。同時也是 scrollback 快照的上限來源 —— 存比終端裝得下
 * 更多的內容沒有意義。
 */
export const SCROLLBACK_LINES = 5000;

interface TermOptionsInput {
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

/**
 * ⚠️ allowProposedApi 與 allowTransparency 都是必要的，不可為了精簡拿掉：
 * 前者是 buffer/parser 等 addon 級 API 的開關，後者讓自訂背景圖能透出。
 *
 * allowTransparency 是已知的繪製成本（xterm.js 自己的文件就標了會影響效能：
 * 每格都得先清空再疊字，不能靠不透明底色直接覆蓋）。這是背景圖功能的必要代價，
 * 調 renderer 效能時不要誤以為它是可以順手拿掉的旋鈕。
 */
export function buildTermOptions(input: TermOptionsInput, theme: ITheme): ITerminalOptions {
  return {
    fontFamily: withSymbolsFallback(input.fontFamily),
    fontSize: input.fontSize,
    cursorStyle: input.cursorStyle,
    cursorBlink: input.cursorBlink,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
    allowTransparency: true,
    theme,
  };
}
