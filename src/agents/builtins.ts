// 內建 agent profiles 與 launchers。
// 這些只是「預設值」——使用者可透過 app config dir 的 agents.json 覆寫或新增，
// 所以本系統並不綁定 Claude Code / Codex，任何 CLI agent 都能加進來。
import type { AgentLauncher, AgentProfile } from "./types";

// 通用 fallback：涵蓋常見的審批/錯誤字樣，適用任何未特別定義的工具。
export const GENERIC_PROFILE: AgentProfile = {
  id: "generic",
  label: "Agent",
  states: {
    // Strong signals only. y/n forms are anchored to end of line so an
    // already-answered prompt still visible on screen ("... (y/n): y") no
    // longer counts; case variants are enumerated because waiting patterns
    // are matched case-sensitively (see engine.deriveState).
      waiting:
      "\\([yY]\\/[nN]\\)\\s*:?\\s*$|\\[[yY]\\/[nN]\\]\\s*:?\\s*$|❯\\s*\\d+\\.\\s*(Yes|Allow|Run|Apply|Proceed)",
    thinking: "thinking|working|analyz|generating|processing|⠋|⠙|⠹|⠸|⠼",
    tool: "running|executing|\\$\\s|\\brunning tool\\b|tool call",
    error: "\\berror\\b|\\bfailed\\b|traceback|exception",
    done: "\\bdone\\b|completed|finished|✔|✓",
  },
  extract: {
    cost: "cost[^$]*\\$\\s?([0-9]+(?:\\.[0-9]+)?)",
    tokensIn: "([0-9,]+)\\s*(?:input|prompt)\\s*tokens",
    tokensOut: "([0-9,]+)\\s*(?:output|completion)\\s*tokens",
    fileChange:
      "\\b(edited|wrote|created|modified|updated|edit|write|create|update)\\b[:\\s]+([^\\s]+\\.[A-Za-z0-9]+)",
  },
  approve: "y\r",
  reject: "n\r",
};

export const BUILTIN_PROFILES: AgentProfile[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detectOutput: "Claude Code|anthropic|claude\\.ai\\/code",
    // 終端標題（2.1.206 實測）：忙碌時「盲文 spinner + 任務摘要」（⠐ Create …，
    // 字元在 U+2800–U+28FF 內輪替），靜止（閒置/審批/完成）時「✳ + 摘要」，
    // 退出時清成空字串。標題分不出審批與閒置，waiting 仍靠畫面掃描。
    title: { busy: "^[\\u2800-\\u28FF]", rest: "^✳" },
    states: {
    // 以下皆對照 Claude Code 2.1.x 實際 TUI 輸出校準。
      // Only match an active approval menu: the ❯ arrow pointing at a
      // numbered affirmative option. Matched per line and case-sensitively
      // (engine.deriveState), so a trailing ❯ prompt plus a numbered list on
      // another line, or lowercase prose like "1. yes we could", won't trigger.
      waiting: "❯\\s*\\d+\\.\\s*(Yes|Allow|Run|Apply|Proceed|Create)",
      // 思考中：spinner 提示「(esc to interrupt)」或 "thinking" 字樣；單獨的
      // 裝飾性星號 ✻✽… 不算——閒置畫面會殘留星號，否則會蓋掉 composer-at-rest
      // 的 done 判定，讓閒置燈跟思考中燈一樣跳動（見 engine.deriveState）。
      thinking: "esc to interrupt|\\bthinking\\b",
      // 工具呼叫：bullet 後接工具動詞（● Write(...) / ⏺ Running …）。
      // 2.1.206 實測 bullet 是 ● U+25CF；保留 ⏺ 相容舊版。
      tool: "[⏺●]\\s*(Running|Ran|Reading|Writing|Searching|Fetching|Update|Edit|MultiEdit|Write|Read|Create|Bash|Grep|Glob)\\b",
      error: "\\berror\\b|failed|API Error",
      // 完成：「Done.」、「Worked for 5s」或 2.1.x 的隨機動詞完成行
      // （✻ Crunched for 12s / ✻ Cogitated for 13s …）。
      done: "\\bDone\\.|Worked for \\d|✻\\s+\\w+ for \\d+s",
      // 排除啟動/設定類的一次性提示（信任資料夾、選主題、登入等）。
      ignore:
        "trust\\s*(this folder|the files)|Security\\s*guide|choose.*text style|Select\\s*(theme|login)|Sign in|Log in|Welcome to Claude",
      // 輸入框（composer）列：圓角框內的「│ > …」或閒置時的「? for shortcuts」
      // 提示。作用中的審批對話框會取代輸入框，所以它出現在選單下方時，
      // 該選單必為已回答的殘影（見 engine.deriveState 的 stale-menu veto）。
      inputBox: "^\\s*│\\s*>(\\s|$)|\\?\\s*for shortcuts",
      // AskUserQuestion 這類任意選項的選單列；engine 要求上方有問題行才判
      // waiting（kind = "question"），散文編號清單不會誤判。
      menuOption: "^\\s*❯\\s*\\d+\\.\\s",
      // plan 模式的執行確認對話框標記 → kind = "plan"（請對照實際 TUI 校準）。
      planMode: "Would you like to proceed\\?|Here is Claude'?s plan",
      // 純文字提問：訊息最後一行以問號結尾（行尾錨定，避免句中問號誤判）。
      // 只在 composer 閒置時比對輸入框上方最後一條內容行（見 engine.deriveState）。
      question: "[?？]\\s*$",
    },
    extract: {
      // 成本：/cost 指令輸出的「Total cost: $X」。
      cost: "(?:total cost|cost)[:\\s]*\\$\\s?([0-9]+(?:\\.[0-9]+)?)",
      // Token 用量顯示於底部：↑ 輸入 / ↓ 輸出，可能帶 k/m 縮寫
      // （例：↑ 75 tokens、↓ 2.1k tokens）。
      tokensIn: "↑\\s*([0-9,]+(?:\\.[0-9]+)?[kmb]?)\\s*tokens?",
      tokensOut: "↓\\s*([0-9,]+(?:\\.[0-9]+)?[kmb]?)\\s*tokens?",
      // 檔案變更：Update/Edit/Write/Create(路徑)（例：⏺ Update(demo.txt)）。
      fileChange: "\\b(Update|Edit|MultiEdit|Write|Create)\\(([^)]+)\\)",
    },
    // 預設按 Enter 接受被 highlight 的第一項；請依實際 UI 於 agents.json 微調。
    approve: "\r",
    reject: "\x1b", // Esc
  },
  {
    id: "codex",
    label: "Codex",
    // No bare "codex": a session must not get permanently tagged just because
    // a filename or chat line mentions the word.
    detectOutput: "Codex CLI|OpenAI Codex",
    // 終端標題（0.146.0）：預設 activity + project-name；忙碌時是盲文
    // spinner，等待操作時是會閃爍的 [ ! ] / [ . ] Action Required。
    // 靜止時只剩專案名，無固定字元可安全辨識，故 rest 不填。
    title: {
      busy: "^[\\u2800-\\u28FF]",
      waiting: "^\\[ [!.] \\] Action Required(?:\\b|$)",
    },
    // OSC 9 訊息（需使用者在 config.toml 的 [tui] 下設 notification_method =
    // "osc9"、notification_condition = "always"）：approval-requested /
    // plan-mode-prompt 的固定前綴 → waiting；其餘 turn-complete 回應預覽才視為
    // 回合結束。以下四個前綴皆為 Codex 0.146.0 binary 內的實際字串。
    notify: {
      waiting: "^Approval requested|^Codex wants to edit",
      plan: "^Plan mode prompt:",
    },
    states: {
      // Approval menu (current Codex TUI): the › selection arrow on a numbered
      // affirmative option ("› 1. Yes, proceed (y)"). The arrow row only exists
      // while the menu is live, so answered prompts left in the viewport don't
      // match. Legacy y/n prompts kept, anchored to end of line (answered
      // prompts stay visible on screen); waiting is matched case-sensitively.
      waiting:
        "[›❯]\\s*\\d+\\.\\s*(Yes|Approve|Allow|Run|Proceed)|Allow command|Run this command|[Aa]pprove\\?|Apply patch\\?|\\([yY]\\/[nN]\\)\\s*:?\\s*$",
      thinking: "Thinking|Working|Reasoning",
      tool: "Running|exec|\\$\\s|patch",
      error: "\\berror\\b|failed",
      done: "\\bdone\\b|completed",
      // Question menu with arbitrary option text ("› 1. 取代箭頭數字"); the
      // engine requires a question line above before treating it as waiting
      // (kind = "question"), so prose numbered lists don't misfire. The arrow
      // row only exists while the menu is live.
      menuOption: "^\\s*[›❯]\\s*\\d+\\.\\s",
    },
    extract: {
      cost: "cost[:\\s]*\\$\\s?([0-9]+(?:\\.[0-9]+)?)",
      // 2026-07-10：Codex TUI 僅公開顯示剩餘 context，不提供 input/output token，
      // 故刻意不設 tokensIn/tokensOut——沒有 token 關鍵字可錨定，任何「數字 +
      // input/prompt」的 regex 只會擷到誤讀（"3 input files"）。
      contextLeftPercent: "([0-9]+(?:\\.[0-9]+)?)%\\s*context\\s*left",
      fileChange: "\\b(Apply patch|patch|edit|create|update)\\b.*?([^\\s]+\\.[A-Za-z0-9]+)",
    },
    approve: "y\r",
    // The menu binds "No" to Esc; "n\r" would press Enter on the highlighted
    // "Yes, proceed" and approve instead.
    reject: "\x1b",
  },
  GENERIC_PROFILE,
];

export const BUILTIN_LAUNCHERS: AgentLauncher[] = [
  { label: "Shell", command: "", profileId: null },
];
