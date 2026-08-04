// OSC 9 payload 過濾（純函式，node 可測）。
// 序列格式：`\x1b]9;<訊息>\x07`，handler 收到的是 `<訊息>` 這段。
//
// 麻煩在於 OSC 9 被兩種用途共用：桌面通知（Codex 只發這種），以及 ConEmu /
// Windows Terminal 的進度回報子命令（`9;4;<state>;<pct>`，ConEmu 另有 9;1～9;3）。
// session 一旦被標成 codex，任何程式（winget、pwsh、build tool）發的進度序列
// 都會落到 deriveNotifySignal 的 fallthrough 被當成「回合結束」，於是誤報 done
// 並清掉 hook waiting 狀態——狀態燈在使用者正被要求審批時變綠。Windows 上這種
// 序列特別常見，故在這裡先擋掉。

/** Filter an OSC 9 payload. Returns the user-facing notification text, or null
 *  for ConEmu/Windows-Terminal progress subcommands and empty payloads
 *  (nothing to derive agent state from). */
export function decodeOsc9(data: string): string | null {
  const text = data.trim();
  if (!text) return null;
  // 判別規則刻意保守：只有「開頭是 1–4 且緊接分號或字串結束」才算子命令。
  // 不用「開頭是數字就丟」——真實通知可能以數字開頭（"3 files changed"），而
  // 漏掉一則審批通知的代價遠高於多轉一則進度 payload。限定 1–4 是因為 ConEmu
  // 只定義到 4，故 "52;..." 這種更大的數字要放行。
  if (/^[1-4](;|$)/.test(text)) return null;
  return text;
}
