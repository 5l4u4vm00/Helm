// 拖放落點（視窗座標）→ 該落在哪個 session 的 pane。
//
// 為什麼需要這個：OS 的檔案拖放在 Tauri 只有**一個** webview 層級的事件，帶的是
// 視窗座標，不像 HTML5 DnD 會冒泡到具體元素。所以命中判定得自己算 —— 而 split
// 佈局下算錯的後果是路徑寫進了隔壁 pane 的 agent，使用者看不出為什麼。
//
// 幾何全部走 layout 已經算好的 RectPct（相對 terminal-area 的百分比），而不是
// 讀 DOM：同一份 rect 也是 App.tsx 拿去畫 pane 的來源，兩邊用同一個數字就不可能
// 對不齊。呼叫端只需負責把視窗座標換算成 terminal-area 內的百分比座標。

import type { RectPct } from "../../store/layoutTree";

/** 一個候選落點：某個 session 佔據的可見矩形。 */
export interface DropCandidate {
  sessionId: string;
  rect: RectPct;
}

/** terminal-area 內的落點，單位為該區域的百分比（0–100）。 */
export interface DropPointPct {
  x: number;
  y: number;
}

/**
 * 視窗座標 → terminal-area 百分比座標。
 *
 * 落在區域外時回傳 null（拖到 sidebar、toolbar 或視窗邊框上）—— 那不是「離最近
 * 的 pane」，而是「沒有目標」，不該猜。
 */
export function toAreaPoint(
  clientX: number,
  clientY: number,
  area: { left: number; top: number; width: number; height: number },
): DropPointPct | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const x = ((clientX - area.left) / area.width) * 100;
  const y = ((clientY - area.top) / area.height) * 100;
  if (x < 0 || x > 100 || y < 0 || y > 100) return null;
  return { x, y };
}

/**
 * 落點命中哪個候選 pane。
 *
 * 邊界採「上/左含、下/右不含」：相鄰 pane 的 rect 在分隔線上共用同一個座標值，
 * 兩邊都用閉區間的話那條線會同時命中兩個 pane，命中結果就取決於陣列順序 ——
 * 半開區間讓每個點只屬於一個 pane。最右/最下緣（正好 100）是唯一例外，否則
 * 視窗最邊緣一列永遠命不中。
 */
export function paneAt(
  point: DropPointPct,
  candidates: readonly DropCandidate[],
): string | null {
  for (const { sessionId, rect } of candidates) {
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    const inX = point.x >= rect.left && (point.x < right || (right >= 100 && point.x <= 100));
    const inY = point.y >= rect.top && (point.y < bottom || (bottom >= 100 && point.y <= 100));
    if (inX && inY) return sessionId;
  }
  return null;
}

/**
 * 完整解析：座標 + 候選 + 後備 session → 目標 session id。
 *
 * 命不中任何 pane 時落回 `fallbackId`（作用中的 session）。理由是拖放已經是個
 * 明確的使用者意圖，把它靜默丟掉比送到作用中的 pane 更難理解 —— 後者至少看得
 * 見結果，而且路徑不會自己執行（我們不送 Enter），使用者能直接改。
 */
export function resolveDropTarget(
  point: DropPointPct | null,
  candidates: readonly DropCandidate[],
  fallbackId: string | null,
): string | null {
  if (point === null) return fallbackId;
  return paneAt(point, candidates) ?? fallbackId;
}
