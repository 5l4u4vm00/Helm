// Agent registry：合併內建 profiles/launchers 與使用者 agents.json。
import { invoke } from "@tauri-apps/api/core";
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。
import { BUILTIN_LAUNCHERS, BUILTIN_PROFILES, GENERIC_PROFILE } from "./builtins.ts";
import { deriveNotifySignal } from "./engine.ts";
import { normalizeResume } from "./resume.ts";
import type { AgentConfig, AgentLauncher, AgentProfile } from "./types";

let profiles = new Map<string, AgentProfile>();
let launchers: AgentLauncher[] = [];
// detectOutput 的編譯快取（null = 無效 regex）：detectProfile 在尚未偵測到
// agent 的 session 每次 scan 都會跑，不能每次重編。profiles 變動時重建。
let detectRegexes = new Map<string, RegExp | null>();

function compileDetectRegexes() {
  detectRegexes = new Map(
    [...profiles.values()].map((p) => {
      if (!p.detectOutput) return [p.id, null] as const;
      try {
        return [p.id, new RegExp(p.detectOutput, "i")] as const;
      } catch {
        return [p.id, null] as const; // 無效 regex 忽略
      }
    }),
  );
}

function reset() {
  profiles = new Map(BUILTIN_PROFILES.map((p) => [p.id, p]));
  launchers = [...BUILTIN_LAUNCHERS];
  compileDetectRegexes();
}
reset();

/**
 * 使用者 profile 的欄位正規化。pattern 類欄位一律照原樣採用（無效 regex 在
 * 使用點各自吞掉），但 resume 例外：它會被寫進 PTY 去執行，半殘的樣板可能接到
 * 錯的對話，所以在這裡就收斂成「可用」或「沒有」（見 resume.normalizeResume）。
 */
export function normalizeProfile(p: AgentProfile): AgentProfile {
  return { ...p, resume: normalizeResume(p.resume) };
}

/** 啟動時載入使用者設定並合併（使用者同 id 覆寫內建，launchers 追加）。 */
export async function initRegistry(): Promise<void> {
  reset();
  try {
    const raw = await invoke<string | null>("read_agents_config");
    if (!raw) return;
    const cfg = JSON.parse(raw) as AgentConfig;
    for (const p of cfg.profiles ?? []) profiles.set(p.id, normalizeProfile(p));
    for (const l of cfg.launchers ?? []) launchers.push(l);
    compileDetectRegexes();
  } catch {
    // 設定不存在或格式錯誤時，靜默沿用內建。
  }
}

export function getProfile(id: string | null | undefined): AgentProfile {
  if (id && profiles.has(id)) return profiles.get(id)!;
  return GENERIC_PROFILE;
}

export function listLaunchers(): AgentLauncher[] {
  return launchers;
}

/** 從輸出被動偵測 agent（供在 shell 內手動啟動的情形）。 */
export function detectProfile(text: string): AgentProfile | null {
  for (const p of profiles.values()) {
    if (detectRegexes.get(p.id)?.test(text)) return p;
  }
  return null;
}

/**
 * 從 OSC 9 通知訊息偵測 agent：waiting 前綴（如 "Approval requested"）夠
 * 特異，可兼作尚未偵測 session 的辨識；其他通知訊息（任意文字）不做偵測。
 */
export function detectNotifyProfile(message: string): AgentProfile | null {
  for (const p of profiles.values()) {
    if (deriveNotifySignal(p, message)?.state === "waiting") return p;
  }
  return null;
}
