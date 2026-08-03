// Pane 標題列上的「接續 agent 對話」按鈕。
//
// 預設不自動 resume（設定裡才有開關）：一次對 8 個 pane 送 claude --resume 會
// 燒 token、可能撞 rate limit，而且 resume 是**以目錄為 scope** 的，工作目錄
// 搬過的 pane 只會得到滿螢幕的 "No conversation found"。
//
// 實作歸屬：W-06 feat/agent-resume。foundation 只建立空殼並在 PaneLabel 接好，
// 讓那條支線不必碰已凍結的 PaneLabel.tsx。
import type { Session } from "../../store/sessions";
import "./ResumeButton.css";

export function ResumeButton(_props: { session: Session }): React.ReactElement | null {
  return null; // W-06
}
