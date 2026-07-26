// Pure changed-file merge tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/changed-files.test.ts
import assert from "node:assert";
import { CHANGED_FILES_CAP, mergeChangedFile } from "../src/store/changedFiles.ts";
import type { ChangedFile } from "../src/agents/extract.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

const scan = (path: string, op = "Update"): ChangedFile => ({ op, path, source: "scan" });
const hook = (path: string, op = "Edit", cwd?: string): ChangedFile => ({
  op,
  path,
  source: "hook",
  ...(cwd ? { cwd } : {}),
});

// --- no-op detection (viewport re-scans hit this constantly) ---
{
  const files = [scan("a.ts")];
  check("完全相同 → 回傳同一個陣列引用（呼叫端可跳過 store 寫入）",
    mergeChangedFile(files, scan("a.ts")) === files);
}

// --- append ---
{
  const out = mergeChangedFile([scan("a.ts")], scan("b.ts"));
  check("新路徑 → 追加", out.length === 2 && out[1].path === "b.ts");
}

// --- op update in place ---
{
  const out = mergeChangedFile([scan("a.ts", "Update")], scan("a.ts", "Write"));
  check("相同路徑不同 op → 原地更新", out.length === 1 && out[0].op === "Write");
}

// --- provenance only improves ---
{
  const out = mergeChangedFile([hook("/repo/a.ts")], scan("/repo/a.ts"));
  check("hook 絕不被降級為 scan", out[0].source === "hook");
  check("降級情境仍會更新 op", out[0].op === "Update");
}

{
  const out = mergeChangedFile([scan("/repo/a.ts")], hook("/repo/a.ts"));
  check("scan 可被升級為 hook", out[0].source === "hook");
}

{
  const out = mergeChangedFile([hook("/repo/a.ts", "Edit", "/repo")], scan("/repo/a.ts"));
  check("既有的 cwd 不會被沒帶 cwd 的條目清掉", out[0].cwd === "/repo");
}

// --- basename upgrade: the whole reason this module exists ---
{
  const files = [scan("x.ts"), scan("a.ts"), scan("y.ts")];
  const out = mergeChangedFile(files, hook("/repo/src/a.ts"));
  check("絕對路徑升級同名的相對條目（不新增一列）", out.length === 3);
  check("升級後保留原本位置（串流時清單不跳動）", out[1].path === "/repo/src/a.ts");
  check("升級後 source 變成 hook", out[1].source === "hook");
  check("其他條目不受影響", out[0].path === "x.ts" && out[2].path === "y.ts");
}

{
  const out = mergeChangedFile([hook("/other/a.ts")], hook("/repo/a.ts"));
  check("既有條目已是 hook → 不做 basename 升級，視為不同檔案", out.length === 2);
}

{
  const out = mergeChangedFile([scan("/abs/a.ts")], hook("/repo/a.ts"));
  check("既有條目已是絕對路徑 → 不合併（可能真的是不同檔案）", out.length === 2);
}

{
  const out = mergeChangedFile([scan("src\\a.ts")], hook("C:\\repo\\src\\a.ts"));
  check("Windows 分隔符也能做 basename 升級", out.length === 1 && out[0].source === "hook");
}

// --- cap ---
{
  const files: ChangedFile[] = Array.from({ length: CHANGED_FILES_CAP }, (_, i) => scan(`f${i}.ts`));
  const out = mergeChangedFile(files, scan("new.ts"));
  check("超過上限時長度不變", out.length === CHANGED_FILES_CAP);
  check("丟掉最舊的", out[0].path === "f1.ts");
  check("保留最新的", out[out.length - 1].path === "new.ts");
}

console.log(`changed-files: ${passed} checks passed`);
