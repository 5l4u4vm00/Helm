// 接續（resume）既有 agent 對話的純函式：指令解析、失敗訊息比對、
// 使用者 profile 的欄位正規化。無執行期依賴，node 測試可直接載入。
//
// 為什麼指令一律由 profile 決定：Helm 不綁任何 CLI，`claude --resume` 只是
// claude-code profile 的一筆資料。程式碼裡出現字面 "claude" 就等於把接續能力
// 焊死在一個工具上（見 CLAUDE.md 的 agent profile 系統）。
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。
import { newestUsableAgentSessionId } from "../store/agentIdentity.ts";
import { stripAnsi } from "./engine.ts";
import type { AgentProfile, AgentResume } from "./types";

/**
 * 解析出來的接續方式，決定 UI 怎麼標示這顆按鈕：
 * - "resume"：以記下來的 agent session id 接回**那一段**對話（最精確）。
 * - "continue"：接回該目錄最近一次對話（沒 id 時的降級，可能不是同一段）。
 * - "relaunch"：什麼都接不到，只是重跑原本的啟動指令 —— 全新對話，
 *   所以刻意不叫 resume，不能讓使用者以為上下文回來了。
 */
export type ResumeKind = "resume" | "continue" | "relaunch";

export interface ResumePlan {
  kind: ResumeKind;
  /** 要寫進 PTY 的指令本體（不含換行，呼叫端負責加 \r）。 */
  command: string;
  /**
   * kind === "resume" 時鎖定的 agent session id，供失敗時標記它；其餘為 null
   * （沒有特定 id 可以怪，一次失敗不該讓任何 id 被判死）。
   */
  agentSessionId: string | null;
}

const ID_PLACEHOLDER = "{id}";

/**
 * 決定「按下接續會送出什麼指令」。順序（前者永遠優先）：
 * 1. 最新一個**未失敗**的 agent session id + `byId` → 接回那段對話。
 * 2. `latest`（`--continue`）→ 沒裝 hook 時的優雅降級。
 * 3. 原本的啟動指令 → 標成 relaunch，不是接續。
 * 4. null → 沒有可送出的指令，UI 不顯示按鈕。
 *
 * profile 沒有 resume 欄位就直接 null：不支援接續的 agent（Codex / generic /
 * 純 shell）連 relaunch 都不該從這條路走 —— 那是「重開」而不是「接續」，
 * 混進來只會讓按鈕的語意變成「隨便再跑一次」。
 *
 * isFailed 由執行期狀態注入（見 store/resumeState.ts），讓本函式保持純粹。
 */
export function resolveResumePlan(
  profile: AgentProfile | null | undefined,
  agentSessionIds: readonly string[] | undefined,
  lastLaunchCommand: string | undefined,
  isFailed: (agentSessionId: string) => boolean = () => false,
): ResumePlan | null {
  const resume = profile?.resume;
  if (!resume) return null;
  // 缺 {id} 的樣板不能用：它會接到「最近一次」而不是我們指定的那段，
  // 而呼叫端會以為失敗的是被鎖定的那個 id。
  if (resume.byId?.includes(ID_PLACEHOLDER)) {
    const id = newestUsableAgentSessionId(agentSessionIds, isFailed);
    if (id) {
      return {
        kind: "resume",
        command: resume.byId.split(ID_PLACEHOLDER).join(id),
        agentSessionId: id,
      };
    }
  }
  if (resume.latest) {
    return { kind: "continue", command: resume.latest, agentSessionId: null };
  }
  const relaunch = lastLaunchCommand?.trim();
  if (relaunch) return { kind: "relaunch", command: relaunch, agentSessionId: null };
  return null;
}

// failure pattern 的編譯快取（null = 無效 regex）：這條路跑在掃描頻率上。
const failureCache = new Map<string, RegExp | null>();

function failureRegex(src: string): RegExp | null {
  let re = failureCache.get(src);
  if (re === undefined) {
    try {
      re = new RegExp(src, "i");
    } catch {
      re = null; // 無效 regex（使用者 profile 可能亂寫）→ 永遠不命中
    }
    failureCache.set(src, re);
  }
  return re;
}

/**
 * 掃描文字裡有沒有「這段對話接不回來」的訊號，命中則回傳那一行（供通知顯示
 * 實際訊息，不必為每個 CLI 各寫一句翻譯）；否則 null。
 *
 * 逐行比對而非整段：pattern 裡的 `\s` 不該跨行吃掉半個畫面（同 engine.ts 的
 * testAnyLine 理由）。
 */
export function matchResumeFailure(
  profile: AgentProfile | null | undefined,
  text: string,
): string | null {
  const src = profile?.resume?.failure;
  if (!src) return null;
  const re = failureRegex(src);
  if (!re) return null;
  for (const line of stripAnsi(text).split("\n")) {
    if (re.test(line)) return line.trim().slice(0, 200);
  }
  return null;
}

export function isResumeFailure(
  profile: AgentProfile | null | undefined,
  text: string,
): boolean {
  return matchResumeFailure(profile, text) !== null;
}

function trimmedString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 正規化使用者 agents.json 提供的 resume 欄位。回傳 undefined = 這個 profile
 * 不支援接續（UI 不顯示按鈕），刻意比「保留半殘的設定」保守：
 * - `byId` 少了 `{id}` 佔位符 → 丟掉（見 resolveResumePlan 的理由）。
 * - `failure` 編不成 regex → 丟掉（留著會讓失敗永遠偵測不到，比沒有更難查）。
 * - 連 byId / latest 都沒有 → 整個 resume 沒有意義，回 undefined。
 */
export function normalizeResume(raw: unknown): AgentResume | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const byIdRaw = trimmedString(src.byId);
  const byId = byIdRaw?.includes(ID_PLACEHOLDER) ? byIdRaw : undefined;
  const latest = trimmedString(src.latest);
  if (!byId && !latest) return undefined;
  const failureRaw = trimmedString(src.failure);
  const failure = failureRaw && failureRegex(failureRaw) ? failureRaw : undefined;
  return { byId, latest, failure };
}
