// Agent 掃描要讀哪幾列（純函式，node 測試可直接載入）。
//
// 兩條規則：
// 1. 只讀「目前可見畫面」（baseY 起算的 term.rows 列），刻意不含捲動歷史 ——
//    已回答並捲走的提示不該再被當成作用中的核准。
// 2. 還原重播之後，跳過 floor 以下的列。floor = 重播內容之後第一列的絕對列號；
//    沒有 floor 就傳 0。
//
// 為什麼是 floor 而不是計時寬限：floor 是確定性的 —— 一旦 pane 產出 rows 列
// 真實輸出，baseY >= floor，這個分支自動永久失效（不需要 Map、計時器或清理），
// 而真正的新提示必然在 floor 之後，所以不會被誤殺。計時寬限則要為最壞情況
// 挑一個長度（可見 pane 150ms / 隱藏 pane 1000ms 兩種節奏），還可能吞掉啟動
// 300ms 後才出現的真實審批。
//
// ⚠️ altBuffer 護欄是必需品，不是保險：agent（Claude Code 2.1+）進 alt screen
// 後 baseY 會歸零，若照樣套用 floor，所有列都在 floor 之下 → 該 pane 的 agent
// 偵測會永久失效。alt buffer 沒有捲動歷史、也不可能含有重播內容，因此不套。
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。

/**
 * @param read 讀一列的渲染文字（絕對列號）；沒有該列時回 null。
 * @param baseY 目前 viewport 第一列的絕對列號。
 * @param rows viewport 列數。
 * @param floor 還原重播的界線（0 = 無界線）。
 * @param altBuffer 目前是否在 alternate screen（是 → 不套用 floor）。
 */
export function scanRows(
  read: (row: number) => string | null,
  baseY: number,
  rows: number,
  floor: number,
  altBuffer: boolean,
): string[] {
  const applyFloor = !altBuffer && floor > 0;
  const out: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    const row = baseY + i;
    if (applyFloor && row < floor) continue;
    const line = read(row);
    if (line !== null) out.push(line);
  }
  return out;
}
