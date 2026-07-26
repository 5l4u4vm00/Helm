// 從單行輸出擷取結構化資訊（純函式，方便測試）。
// 由 profile.extract 的 regex 驅動，不綁定特定工具。
import type { AgentProfile } from "./types";

/** One file an agent touched. `source` records how we learned about it:
 *  "hook" paths are trustworthy (absolute, straight from tool_input), while
 *  "scan" paths came from a viewport regex and may be a bare basename or
 *  truncated by the terminal width — the diff view needs to tell them apart. */
export interface ChangedFile {
  op: string;
  path: string;
  source?: "hook" | "scan";
  /** The agent CLI's cwd when the tool ran (hook payload); anchors git. */
  cwd?: string;
}

export interface Extracted {
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  contextLeftPercent?: number;
  file?: ChangedFile;
}

const cache = new Map<string, RegExp>();
function rx(src: string): RegExp | null {
  let re = cache.get(src);
  if (!re) {
    try {
      re = new RegExp(src, "i");
      cache.set(src, re);
    } catch {
      return null;
    }
  }
  return re;
}

// Pre-filter: one combined regex decides whether a line can match any
// extractor at all — the common case (no match) then costs one .test()
// instead of up to four .exec()s. Cached per profile.extract object; a
// null entry disables the pre-filter (falls back to the per-pattern path).
interface PreFilters {
  any: RegExp | null;
  usage: RegExp | null;
}
const preFilterCache = new WeakMap<object, PreFilters>();

// Each source is wrapped in (?:...) so top-level alternation in a
// user-supplied pattern cannot leak across the joined "|". Individually
// invalid sources are skipped (they can never match in num()/exec either).
function compileCombined(sources: (string | undefined)[]): RegExp | null {
  const parts = sources.filter((s): s is string => !!s && rx(s) !== null);
  if (parts.length === 0) return null;
  try {
    return new RegExp(parts.map((s) => `(?:${s})`).join("|"), "i");
  } catch {
    return null;
  }
}

function preFilters(e: NonNullable<AgentProfile["extract"]>): PreFilters {
  let f = preFilterCache.get(e);
  if (!f) {
    f = {
      any: compileCombined([e.cost, e.tokensIn, e.tokensOut, e.contextLeftPercent, e.fileChange]),
      usage: compileCombined([e.cost, e.tokensIn, e.tokensOut, e.contextLeftPercent]),
    };
    preFilterCache.set(e, f);
  }
  return f;
}

// k/m/b 後綴 → 倍率（Claude Code footer 會顯示 2.1k tokens 這種縮寫）。
const SUFFIX_MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
};

// 抓第一個 capture group 的數字（去掉千分位逗號，支援 k/m/b 後綴）。
function num(src: string | undefined, line: string): number | undefined {
  if (!src) return undefined;
  const re = rx(src);
  const m = re?.exec(line);
  if (!m || !m[1]) return undefined;
  let raw = m[1].replace(/,/g, "");
  const mult = SUFFIX_MULTIPLIERS[raw.slice(-1).toLowerCase()] ?? 1;
  if (mult !== 1) {
    raw = raw.slice(0, -1);
  }
  const n = parseFloat(raw) * mult;
  return Number.isFinite(n) ? n : undefined;
}

export function extractFromLine(profile: AgentProfile, line: string): Extracted {
  const e = profile.extract;
  if (!e) return {};
  const pre = preFilters(e).any;
  if (pre && !pre.test(line)) return {};
  const out: Extracted = {};

  const cost = num(e.cost, line);
  if (cost !== undefined) out.cost = cost;
  const ti = num(e.tokensIn, line);
  if (ti !== undefined) out.tokensIn = ti;
  const to = num(e.tokensOut, line);
  if (to !== undefined) out.tokensOut = to;
  const context = num(e.contextLeftPercent, line);
  if (context !== undefined) out.contextLeftPercent = context;

  if (e.fileChange) {
    const re = rx(e.fileChange);
    const m = re?.exec(line);
    if (m) {
      // group1=op group2=path；若只有一個 group 就當作 path。
      const op = m[2] ? m[1] : "change";
      const path = (m[2] ?? m[1] ?? "").trim();
      if (path) out.file = { op: op.trim(), path, source: "scan" };
    }
  }
  return out;
}

export type ExtractedUsage = Pick<
  Extracted,
  "cost" | "tokensIn" | "tokensOut" | "contextLeftPercent"
>;

// 從整段已渲染文字（如 xterm viewport）擷取用量統計。
// 只取 cost/tokens（idempotent 的「當前狀態」）；fileChange 另有 viewport 擷取器
// extractFilesFromText。逐行掃描，後面的行覆蓋前面的（footer 靠近底部）。
export function extractUsageFromText(profile: AgentProfile, text: string): ExtractedUsage {
  const out: ExtractedUsage = {};
  if (!profile.extract) return out;
  const pre = preFilters(profile.extract).usage;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (pre && !pre.test(line)) continue;
    const cost = num(profile.extract.cost, line);
    if (cost !== undefined) out.cost = cost;
    const ti = num(profile.extract.tokensIn, line);
    if (ti !== undefined) out.tokensIn = ti;
    const to = num(profile.extract.tokensOut, line);
    if (to !== undefined) out.tokensOut = to;
    const context = num(profile.extract.contextLeftPercent, line);
    if (context !== undefined) out.contextLeftPercent = context;
  }
  return out;
}

// 從整段已渲染文字擷取檔案變更行（Claude Code 2.1+ 以 alt-screen 重繪，raw
// stream 幾乎無換行，逐行的 stream 路徑看不到 ⏺ Update(...)，fileChange 改由
// viewport 擷取；addChangedFile 以 path 去重，重複掃到同一行是 idempotent 的）。
// 同一路徑在一次掃描內去重（後面的行覆蓋前面的 op），避免每次 scan 打多次 store。
export function extractFilesFromText(
  profile: AgentProfile,
  text: string,
): ChangedFile[] {
  const src = profile.extract?.fileChange;
  if (!src) return [];
  const re = rx(src);
  if (!re) return [];
  const byPath = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = re.exec(line);
    if (!m) continue;
    // group1=op group2=path；若只有一個 group 就當作 path（同 extractFromLine）。
    const op = m[2] ? m[1] : "change";
    const path = (m[2] ?? m[1] ?? "").trim();
    if (path) byPath.set(path, op.trim());
  }
  return [...byPath].map(([path, op]) => ({ op, path, source: "scan" as const }));
}
