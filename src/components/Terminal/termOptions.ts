// xterm 建構選項（從 Terminal.tsx 抽出，讓 renderer/scrollback 相關調整不必碰
// 那個檔案）。
import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { withSymbolsFallback } from "../../store/fontFamily";
import type { CursorStyle } from "../../store/settings";

/**
 * scrollback 快照要存幾列的預設上限。與 xterm 的 `scrollback` 設定分開：終端
 * 保留多少列是使用者偏好（settings.scrollback），而快照存多少列是磁碟成本的
 * 取捨，兩者不必相等（存比終端裝得下更多的內容沒有意義，但存少一點是合理的）。
 */
export const SCROLLBACK_SNAPSHOT_LINES = 1000;

interface TermOptionsInput {
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** 使用者可設定的保留列數（見 settings.scrollback）。 */
  scrollback: number;
}

/**
 * ⚠️ allowProposedApi 與 allowTransparency 都是必要的，不可為了精簡拿掉：
 * 前者是 buffer/parser 等 addon 級 API 的開關，後者讓自訂背景圖能透出。
 */
export function buildTermOptions(input: TermOptionsInput, theme: ITheme): ITerminalOptions {
  return {
    fontFamily: withSymbolsFallback(input.fontFamily),
    fontSize: input.fontSize,
    cursorStyle: input.cursorStyle,
    cursorBlink: input.cursorBlink,
    scrollback: input.scrollback,
    allowProposedApi: true,
    allowTransparency: true,
    theme,
  };
}
