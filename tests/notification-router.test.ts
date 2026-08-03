// 提醒事件路由（邊緣偵測 + 桌面通知 gating）的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/notification-router.test.ts
import assert from "node:assert";
import {
  NOTIFY_COOLDOWN_MS,
  clearNotifyDedupe,
  detectAgentEvent,
  shouldDesktopNotify,
  type DesktopNotifyContext,
} from "../src/store/notificationRouter.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- detectAgentEvent：狀態轉移邊緣 ----

check("進入 waiting → promptKind", detectAgentEvent("thinking", "waiting", "approval") === "approval");
check("進入 waiting（question）", detectAgentEvent(undefined, "waiting", "question") === "question");
check("waiting 中換提示不重發（非邊緣）", detectAgentEvent("waiting", "waiting", "approval") === null);
check("thinking → done 發 done", detectAgentEvent("thinking", "done", "approval") === "done");
check("tool → done 發 done", detectAgentEvent("tool", "done", "approval") === "done");
check("waiting → done 發 done（終端內回答後跑完）", detectAgentEvent("waiting", "done", "approval") === "done");
check("undefined → done 不發（殘留 transcript）", detectAgentEvent(undefined, "done", "approval") === null);
check("done → error 不發（非忙碌來源）", detectAgentEvent("done", "error", "approval") === null);
check("tool → error 發 error", detectAgentEvent("tool", "error", "approval") === "error");
check("thinking → tool 不是提醒事件", detectAgentEvent("thinking", "tool", "approval") === null);
check("同狀態不發", detectAgentEvent("done", "done", "approval") === null);
// interrupted / stalled 刻意不從轉移推導：PTY 在 agent 工作中死掉沒有「轉移」
// 可偵測（那正是它以前完全靜默的原因），停滯更是「什麼都沒發生」。
check(
  "轉移偵測永不產出 interrupted / stalled",
  (
    [
      ["thinking", undefined],
      ["tool", "error"],
      ["waiting", "done"],
      [undefined, "thinking"],
    ] as const
  ).every(([prev, next]) => {
    const k = detectAgentEvent(prev, next, "approval");
    return k !== "interrupted" && k !== "stalled";
  }),
);

// ---- shouldDesktopNotify：統一 gating ----

const T0 = 1_000_000;
const base: DesktopNotifyContext = {
  enabled: true,
  windowFocused: false,
  inFocusedWorkspace: true,
  paneVisible: true,
  notifyHiddenPanes: true,
};

check("失焦時 waiting 應通知", shouldDesktopNotify("s1", "approval", "Run ls?", base, T0));
check(
  "同 prompt 於 cooldown 內不重複通知（flapping 抑制）",
  !shouldDesktopNotify("s1", "approval", "Run ls?", base, T0 + 1_000),
);
check(
  "不同 prompt 應立即通知",
  shouldDesktopNotify("s1", "approval", "Delete file?", base, T0 + 2_000),
);
check(
  "換回原 prompt 也視為新審批（紀錄已被覆蓋）",
  shouldDesktopNotify("s1", "approval", "Run ls?", base, T0 + 3_000),
);
check(
  "同 prompt 超過 cooldown 應再通知",
  shouldDesktopNotify("s1", "approval", "Run ls?", base, T0 + 3_000 + NOTIFY_COOLDOWN_MS),
);
check(
  "同 session 不同 kind 各自去重",
  shouldDesktopNotify("s1", "question", "Run ls?", base, T0 + 4_000),
);

// 開關關閉 → 不發、也不留紀錄
{
  const t = T0 + 10_000;
  check(
    "enabled=false 不發",
    !shouldDesktopNotify("s2", "approval", "Apply patch?", { ...base, enabled: false }, t),
  );
  check(
    "關閉時不留去重紀錄（重開後立即可發）",
    shouldDesktopNotify("s2", "approval", "Apply patch?", base, t + 1_000),
  );
}

// 聚焦抑制：waiting 只抑制畫面上的 pane；且抑制不留紀錄（blur 後補發）
{
  const t = T0 + 20_000;
  const focused = { ...base, windowFocused: true };
  check(
    "聚焦 + pane 在畫面上 → waiting 抑制",
    !shouldDesktopNotify("s3", "approval", "Run build?", focused, t),
  );
  check(
    "聚焦但 pane 不在畫面上 → waiting 仍通知（同 workspace 的隱藏 pane）",
    shouldDesktopNotify("s3", "approval", "Run build?", { ...focused, paneVisible: false }, t + 1_000),
  );
  check(
    "抑制不留紀錄：blur 後同 prompt 可補發",
    shouldDesktopNotify("s4", "plan", "Plan ready", base, t + 2_000) &&
      !shouldDesktopNotify("s4", "plan", "Plan ready", base, t + 3_000),
  );
}

// notifyHiddenPanes 關閉 → 沿用舊規則（聚焦 workspace 即抑制，不看 pane）
{
  const t = T0 + 25_000;
  const off = { ...base, windowFocused: true, notifyHiddenPanes: false };
  check(
    "開關關閉：聚焦 workspace 的隱藏 pane → waiting 抑制（舊行為）",
    !shouldDesktopNotify("s9", "approval", "Run build?", { ...off, paneVisible: false }, t),
  );
  check(
    "開關關閉：其他 workspace → waiting 仍通知（舊行為）",
    shouldDesktopNotify(
      "s9",
      "approval",
      "Run build?",
      { ...off, paneVisible: false, inFocusedWorkspace: false },
      t + 1_000,
    ),
  );
}

// done：視窗聚焦即抑制；error：聚焦時只抑制畫面上的 pane（開關開啟時）
{
  const t = T0 + 30_000;
  const focused = { ...base, windowFocused: true, inFocusedWorkspace: false };
  check("聚焦時 done 抑制", !shouldDesktopNotify("s5", "done", "", focused, t));
  check(
    "聚焦時 done 抑制（pane 不在畫面上也一樣）",
    !shouldDesktopNotify("s5", "done", "", { ...focused, paneVisible: false }, t),
  );
  check("聚焦 + pane 在畫面上 → error 抑制", !shouldDesktopNotify("s5", "error", "", focused, t));
  check(
    "聚焦但 pane 不在畫面上 → error 仍通知",
    shouldDesktopNotify("s5", "error", "", { ...focused, paneVisible: false }, t + 500),
  );
  check(
    "開關關閉：聚焦時 error 一律抑制（舊行為）",
    !shouldDesktopNotify(
      "s10",
      "error",
      "",
      { ...focused, paneVisible: false, notifyHiddenPanes: false },
      t + 600,
    ),
  );
  check("失焦時 done 通知", shouldDesktopNotify("s5", "done", "", base, t + 1_000));
  check(
    "done 同內容 cooldown 內不重發",
    !shouldDesktopNotify("s5", "done", "", base, t + 2_000),
  );
}

// interrupted / stalled 與 error 共用同一條聚焦規則
{
  const t = T0 + 35_000;
  const focused = { ...base, windowFocused: true, inFocusedWorkspace: false };
  for (const kind of ["interrupted", "stalled"] as const) {
    check(
      `聚焦 + pane 在畫面上 → ${kind} 抑制`,
      !shouldDesktopNotify(`s-${kind}`, kind, "", focused, t),
    );
    check(
      `聚焦但 pane 不在畫面上 → ${kind} 仍通知`,
      shouldDesktopNotify(`s-${kind}`, kind, "", { ...focused, paneVisible: false }, t + 500),
    );
    check(
      `開關關閉：聚焦時 ${kind} 一律抑制`,
      !shouldDesktopNotify(
        `s-${kind}-off`,
        kind,
        "",
        { ...focused, paneVisible: false, notifyHiddenPanes: false },
        t + 600,
      ),
    );
    check(`失焦時 ${kind} 通知`, shouldDesktopNotify(`s-${kind}-blur`, kind, "", base, t + 700));
  }
}

// 明確回應（respondApproval）→ 清紀錄 → 同 prompt 立即再通知
{
  const t = T0 + 40_000;
  shouldDesktopNotify("s6", "approval", "Apply patch?", base, t);
  clearNotifyDedupe("s6");
  check(
    "clearNotifyDedupe 後同 prompt 應立即通知",
    shouldDesktopNotify("s6", "approval", "Apply patch?", base, t + 1_000),
  );
}

// session 之間互不影響
{
  const t = T0 + 50_000;
  shouldDesktopNotify("s7", "approval", "Run build?", base, t);
  check(
    "不同 session 的同 prompt 各自獨立",
    shouldDesktopNotify("s8", "approval", "Run build?", base, t + 1_000),
  );
}

console.log(`\n${passed} checks passed.`);
