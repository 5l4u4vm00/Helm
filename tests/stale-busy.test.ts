// 停滯偵測（忙碌但長時間沒有 PTY 輸出）的純函式測試。時間一律注入。
// 執行：node --experimental-strip-types tests/stale-busy.test.ts
import assert from "node:assert";
import {
  STALE_BUSY_THRESHOLD_MS,
  clearStaleBusy,
  detectStaleSessions,
  lastOutput,
  markPtyOutput,
} from "../src/store/staleBusy.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

const T0 = 1_000_000;
const LATER = T0 + STALE_BUSY_THRESHOLD_MS;

// ---- 時間戳表：markPtyOutput / lastOutput / clearStaleBusy ----
check("從未有過輸出時 lastOutput 為 undefined", lastOutput("never") === undefined);
markPtyOutput("a", T0);
check("markPtyOutput 記下時間", lastOutput("a") === T0);
markPtyOutput("a", T0 + 5);
check("後續輸出覆寫時間（取最新）", lastOutput("a") === T0 + 5);
markPtyOutput("b", T0);
check("不同 session 各自記錄", lastOutput("b") === T0);
clearStaleBusy("a");
check("clearStaleBusy 清掉該 session", lastOutput("a") === undefined);
check("clearStaleBusy 不影響其他 session", lastOutput("b") === T0);
clearStaleBusy("b");

check("門檻為正數", STALE_BUSY_THRESHOLD_MS > 0);

// ---- detectStaleSessions：命中 ----
markPtyOutput("busy", T0);
check(
  "忙碌且沉默達門檻 → 命中",
  JSON.stringify(detectStaleSessions([{ id: "busy", agentState: "thinking" }], LATER)) ===
    JSON.stringify(["busy"]),
);
check(
  "tool 也算忙碌",
  detectStaleSessions([{ id: "busy", agentState: "tool" }], LATER).length === 1,
);
check(
  "waiting 也算忙碌（等審批期間 agent 沉默是正常的，但久到異常仍該提醒）",
  detectStaleSessions([{ id: "busy", agentState: "waiting" }], LATER).length === 1,
);
check(
  "沉默遠超門檻仍命中",
  detectStaleSessions(
    [{ id: "busy", agentState: "thinking" }],
    T0 + STALE_BUSY_THRESHOLD_MS * 10,
  ).length === 1,
);

// ---- 不誤報 1：從未有過輸出的 session（剛開的 pane） ----
check(
  "從未有過輸出 → 不算停滯",
  detectStaleSessions([{ id: "fresh", agentState: "thinking" }], LATER).length === 0,
);

// ---- 不誤報 2：已經 stalled 的 session（一次停滯只提醒一次） ----
check(
  "已 stalled → 不再命中",
  detectStaleSessions([{ id: "busy", agentState: "thinking", stalled: true }], LATER)
    .length === 0,
);
check(
  "stalled: false 不算已提醒過",
  detectStaleSessions([{ id: "busy", agentState: "thinking", stalled: false }], LATER)
    .length === 1,
);

// ---- 不誤報 3：非忙碌狀態 ----
check(
  "done → 不命中",
  detectStaleSessions([{ id: "busy", agentState: "done" }], LATER).length === 0,
);
check(
  "error → 不命中",
  detectStaleSessions([{ id: "busy", agentState: "error" }], LATER).length === 0,
);
check(
  "沒有 agentState（純 shell / 還沒偵測到 agent）→ 不命中",
  detectStaleSessions([{ id: "busy" }], LATER).length === 0,
);

// ---- 不誤報 4：剛剛才有輸出 ----
check(
  "剛有輸出 → 不命中",
  detectStaleSessions([{ id: "busy", agentState: "thinking" }], T0 + 1).length === 0,
);
check(
  "差一毫秒未達門檻 → 不命中",
  detectStaleSessions([{ id: "busy", agentState: "thinking" }], LATER - 1).length === 0,
);
check(
  "恰好等於門檻 → 命中（邊界含等於）",
  detectStaleSessions([{ id: "busy", agentState: "thinking" }], LATER).length === 1,
);
check(
  "now 早於最後輸出（時鐘回跳）→ 不命中",
  detectStaleSessions([{ id: "busy", agentState: "thinking" }], T0 - 1000).length === 0,
);

// ---- thresholdMs 可覆寫（注入式，方便呼叫端/測試調整） ----
check(
  "自訂較短門檻 → 提早命中",
  detectStaleSessions([{ id: "busy", agentState: "thinking" }], T0 + 100, 50).length === 1,
);
check(
  "自訂較長門檻 → 尚未命中",
  detectStaleSessions(
    [{ id: "busy", agentState: "thinking" }],
    LATER,
    STALE_BUSY_THRESHOLD_MS * 3,
  ).length === 0,
);

// ---- 多 session：只回傳命中的，且保留輸入順序 ----
markPtyOutput("s1", T0);
markPtyOutput("s2", LATER); // 剛有輸出
markPtyOutput("s3", T0);
check(
  "混合清單只回傳命中者並保留順序",
  JSON.stringify(
    detectStaleSessions(
      [
        { id: "s1", agentState: "thinking" },
        { id: "s2", agentState: "thinking" },
        { id: "s3", agentState: "tool" },
        { id: "s4", agentState: "thinking" }, // 沒有時間戳
        { id: "s5", agentState: "done" },
      ],
      LATER,
    ),
  ) === JSON.stringify(["s1", "s3"]),
);
check("空清單回空陣列", detectStaleSessions([], LATER).length === 0);

// ---- 有新輸出後應解除倒數（即使還沒清 stalled 旗標） ----
markPtyOutput("s1", LATER);
check(
  "新輸出把倒數歸零",
  detectStaleSessions([{ id: "s1", agentState: "thinking" }], LATER + 1).length === 0,
);

console.log(`stale-busy: ${passed} checks passed`);
