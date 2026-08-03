// Scrollback 快照：把每個 pane 的畫面內容存成純文字，重啟後重播成「靜態記錄」。
//
// 兩個關鍵設計，實作時不能改：
// 1. **抓 buffer.normal，不抓 buffer.active。** agent 執行中 active 是 alt
//    buffer —— 一張半畫好的全螢幕框、沒有捲動歷史、只有 CLI 自己能重建；存它
//    只會得到髒畫面。normal 裡是 TUI 接手前 shell 印的東西，那才是我們的。
// 2. **存純渲染文字，不用 addon-serialize。** Helm 對 OSC 9（桌面通知）、
//    OSC 52（剪貼簿）、OSC 0/2（標題）都有 live handler，重播序列化後的控制
//    序列會誤觸這些副作用。純文字一個都觸發不了。代價是還原的歷史沒有顏色 ——
//    可接受，因為那段本來就要標成靜態記錄。
//
// 實作歸屬：W-05 feat/scrollback-snapshot。foundation 只固定簽名並在
// Terminal.tsx 接好呼叫時序（重播必須在 spawnPty 之前）。
import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * 重播這個 session 存下來的畫面，回傳 **scan floor**：重播內容之後第一列的
 * 絕對列號。Terminal 的 readBufferText 會跳過 floor 以下的列，否則第一次真實
 * 掃描會從重播的舊畫面撈出過期的審批提示 —— 症狀是「重啟後莫名跳出上次的核准
 * 請求」。沒有可重播的內容時回 0（代表沒有 floor）。
 */
export function replayScrollback(_term: XTerm, _sessionId: string): Promise<number> {
  return Promise.resolve(0); // W-05
}

/** buffer.normal 的一列：邏輯行的重接（isWrapped）留給擷取端處理。 */
export interface BufferLine {
  text: string;
  wrapped: boolean;
}

/**
 * 註冊這個 pane 的擷取函式。pull-based 是唯一能從 React 外面讀到 xterm buffer
 * 的方式（同 Terminal.tsx 既有的 latest-ref 風格）。Terminal.tsx 只負責把
 * buffer.normal 的列交出來，行重接/裁切/上限都在本模組。
 */
export function registerScrollbackSource(
  _sessionId: string,
  _read: () => BufferLine[],
): void {
  // W-05
}

export function unregisterScrollbackSource(_sessionId: string): void {
  // W-05
}

/** 開始定期擷取並寫出（idle debounce + 定時 sweep，順便清掉孤兒檔）。 */
export function startScrollbackPersistence(): void {
  // W-05
}

/** 立刻寫出所有 pane（關窗前）。 */
export function flushScrollback(): Promise<void> {
  return Promise.resolve(); // W-05
}
