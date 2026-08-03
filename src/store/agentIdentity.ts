// Agent 自己的 session id（Claude Code 等 CLI 在每個 hook payload 裡回報的
// session_id）的純函式操作。無執行期依賴，node 測試可直接載入。
//
// 為什麼是 append-only 的陣列而不是單一欄位：
// 1. `claude --resume` 每次接續都會發一個新的 id（輪替），只記一次會過期。
// 2. 更重要的是安全邊界 —— 另一個工具（herdr #823）把 id 存成唯一一份，並在
//    「偵測到 process exit」時無條件清掉；client 斷線導致畫面重繪被誤判成
//    exit，id 就永久消失，pane 從此只是個空 shell。改成「只增不減」之後，
//    「不會弄丟 id」變成資料結構的性質，而不是一條要靠人記得的規則。
//
// 因此這個模組沒有 remove/prune：resume 失敗只記在執行期狀態（見
// store/resumeState.ts），程序結束就忘掉，最壞情況是損失一次便利，不會造成
// 永久無法接續。

/** 每個 session 最多保留幾個 id（尾端最新）。輪替很久的長壽 session 也不會無限成長。 */
export const AGENT_SESSION_ID_CAP = 8;

/**
 * 追加一個 agent session id。已經是最新一筆、或 id 為空 → 回傳原參照（呼叫端
 * 據此短路 set()，因為這條路跑在 hook 事件頻率上）。
 * 重複出現在較舊位置的 id 會被移到尾端（那是它最近一次被回報的時間）。
 */
export function appendAgentSessionId(
  list: readonly string[] | undefined,
  id: string | undefined,
): readonly string[] | undefined {
  if (!id) return list;
  const cur = list ?? [];
  if (cur.length > 0 && cur[cur.length - 1] === id) return list;
  const next = cur.filter((x) => x !== id);
  next.push(id);
  return next.length > AGENT_SESSION_ID_CAP
    ? next.slice(next.length - AGENT_SESSION_ID_CAP)
    : next;
}

/** 最新回報的 id（resume 的首選）。 */
export function latestAgentSessionId(list: readonly string[] | undefined): string | undefined {
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/**
 * 最新一個「還沒被判定為失敗」的 id。isFailed 由執行期狀態注入，讓本模組保持
 * 純粹。全都失敗過 → undefined（呼叫端改走 latest / 全新啟動）。
 */
export function newestUsableAgentSessionId(
  list: readonly string[] | undefined,
  isFailed: (id: string) => boolean = () => false,
): string | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!isFailed(list[i])) return list[i];
  }
  return undefined;
}
