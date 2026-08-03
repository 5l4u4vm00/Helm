// Agent session id（append-only 清單）的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/agent-identity.test.ts
import assert from "node:assert";
import {
  AGENT_SESSION_ID_CAP,
  appendAgentSessionId,
  latestAgentSessionId,
  newestUsableAgentSessionId,
} from "../src/store/agentIdentity.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- appendAgentSessionId ----

check("undefined + 新 id → 單筆", JSON.stringify(appendAgentSessionId(undefined, "a")) === '["a"]');
check("空 id 不動（回原參照）", appendAgentSessionId(undefined, undefined) === undefined);
{
  const list = ["a"];
  check("id 已是最新一筆 → 回原參照（短路 set）", appendAgentSessionId(list, "a") === list);
  check(
    "空字串視為沒有 id",
    appendAgentSessionId(list, "") === list,
  );
}
check(
  "輪替：新 id 追加在尾端",
  JSON.stringify(appendAgentSessionId(["a", "b"], "c")) === '["a","b","c"]',
);
check(
  "舊 id 再次回報 → 移到尾端（那是它最近一次出現的時間）",
  JSON.stringify(appendAgentSessionId(["a", "b", "c"], "a")) === '["b","c","a"]',
);

// 上限：留尾端最新的 CAP 筆
{
  let list: readonly string[] | undefined;
  for (let i = 0; i < AGENT_SESSION_ID_CAP + 3; i += 1) {
    list = appendAgentSessionId(list, `id${i}`);
  }
  check("不超過上限", (list ?? []).length === AGENT_SESSION_ID_CAP);
  check(
    "丟掉最舊、留住最新",
    latestAgentSessionId(list) === `id${AGENT_SESSION_ID_CAP + 2}` &&
      !(list ?? []).includes("id0"),
  );
}

// ---- 只增不減（herdr #823 的教訓）----

// 一次 resume 失敗不該讓 id 永久消失（herdr #823：唯一一份 id 被 exit 誤判清掉，
// pane 從此只是空 shell）。失敗只記在執行期狀態，這裡的清單長度只增不減。
{
  const inputs = ["a", "b", "a", "c", "", "c", "d"];
  let list: readonly string[] | undefined;
  let shrank = false;
  for (const id of inputs) {
    const before = (list ?? []).length;
    list = appendAgentSessionId(list, id || undefined);
    if ((list ?? []).length < before) shrank = true;
  }
  check("任何輸入序列都不會讓清單變短", !shrank);
  check("同一個 id 不會重複佔位", new Set(list ?? []).size === (list ?? []).length);
}

// ---- latest / newestUsable ----

check("latest：空清單 → undefined", latestAgentSessionId([]) === undefined);
check("latest：尾端最新", latestAgentSessionId(["a", "b"]) === "b");
check(
  "newestUsable：預設沒有失敗紀錄 → 等於 latest",
  newestUsableAgentSessionId(["a", "b"]) === "b",
);
check(
  "newestUsable：跳過失敗的，退到上一個",
  newestUsableAgentSessionId(["a", "b", "c"], (id) => id === "c") === "b",
);
check(
  "newestUsable：全都失敗過 → undefined（改走 latest/全新啟動）",
  newestUsableAgentSessionId(["a", "b"], () => true) === undefined,
);
check("newestUsable：undefined 清單 → undefined", newestUsableAgentSessionId(undefined) === undefined);

console.log(`\nagent-identity: ${passed} checks passed.`);
