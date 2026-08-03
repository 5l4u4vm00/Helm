// Pane 標題列上的「接續 agent 對話」按鈕。
//
// 預設不自動 resume（設定裡才有開關）：一次對 8 個 pane 送 claude --resume 會
// 燒 token、可能撞 rate limit，而且 resume 是**以目錄為 scope** 的，工作目錄
// 搬過的 pane 只會得到滿螢幕的 "No conversation found"。
import { getProfile } from "../../agents/registry";
import { resumePlanForSession, resumeSessionAgent } from "../../commands/actions";
import { useT } from "../../i18n";
import type { Session } from "../../store/sessions";
import "./ResumeButton.css";

// kind 對應的字形：接得回對話用循環箭頭，relaunch（全新對話）用播放三角，
// 免得使用者以為上下文回來了。Relaunch/Resume 沒有各自的翻譯字串，所以
// tooltip 一律附上「實際會送出的指令」—— 那是最不會過期的說明。
const KIND_ICONS = { resume: "⟳", continue: "⟳", relaunch: "▷" } as const;

export function ResumeButton({ session }: { session: Session }): React.ReactElement | null {
  const t = useT();
  // 這個 agent 根本不支援接續（Codex / generic / 純 shell）→ 不出現按鈕，而不是
  // 給一顆永遠按不動的。有支援但暫時解不出指令（跑到一半、還沒有任何 id）才
  // disabled，那是「等一下就能按」。
  if (!session.agentId || !getProfile(session.agentId).resume) return null;
  const plan = resumePlanForSession(session);
  const label = session.agentLabel ?? "Agent";
  return (
    <button
      className="pane-resume"
      data-resume-kind={plan?.kind}
      disabled={!plan}
      title={
        plan
          ? `${t("pane.resume", { label })}\n${plan.command}`
          : t("pane.resumeUnavailable")
      }
      onClick={(e) => {
        e.stopPropagation();
        resumeSessionAgent(session.id);
      }}
    >
      {plan ? KIND_ICONS[plan.kind] : "⟳"}
    </button>
  );
}
