// Pure diff-base resolution tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/diff-target.test.ts
import assert from "node:assert";
import { isAbsolutePath, resolveDiffBase } from "../src/diff/diffTarget.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// --- isAbsolutePath ---
check("POSIX 絕對路徑", isAbsolutePath("/a/b.ts"));
check("Windows 磁碟機 + 反斜線", isAbsolutePath("C:\\a\\b.ts"));
check("Windows 磁碟機 + 正斜線", isAbsolutePath("C:/a/b.ts"));
check("UNC 路徑", isAbsolutePath("\\\\server\\share\\a.ts"));
check("相對路徑不是絕對", !isAbsolutePath("src/a.ts"));
check("裸檔名不是絕對", !isAbsolutePath("a.ts"));

// --- resolution priority ---
{
  // 絕對路徑對使用者 cd 免疫，勝過一切，且不需要 baseDir。
  const r = resolveDiffBase(
    { path: "/repo/src/a.ts", source: "hook", cwd: "/other" },
    { cwd: "/stale" },
    "/default",
  );
  check("絕對路徑勝過一切且不帶 baseDir", r.baseDir === undefined && r.path === "/repo/src/a.ts");
  check("絕對路徑沒有 reason", r.reason === undefined);
}

{
  const r = resolveDiffBase(
    { path: "src/a.ts", source: "hook", cwd: "/live" },
    { cwd: "/stale" },
    "/default",
  );
  check("hook 的 cwd 勝過 session.cwd", r.baseDir === "/live");
}

{
  const r = resolveDiffBase({ path: "src/a.ts", source: "scan" }, { cwd: "/sess" }, "/default");
  check("session.cwd 勝過 defaultCwd", r.baseDir === "/sess");
}

{
  const r = resolveDiffBase({ path: "src/a.ts", source: "scan" }, undefined, "/default");
  check("沒有 session 時退回 defaultCwd", r.baseDir === "/default");
}

{
  const r = resolveDiffBase({ path: "src/a.ts", source: "scan" }, { cwd: undefined }, "");
  check("全都沒有 → unresolvable", r.reason === "unresolvable");
}

{
  const r = resolveDiffBase({ path: "src/a.ts", source: "hook", cwd: "" }, { cwd: "/sess" }, "");
  check("空字串 cwd 不算數，往下退到 session.cwd", r.baseDir === "/sess");
}

// --- pre-IPC rejections ---
{
  const r = resolveDiffBase({ path: "src/…/a.ts", source: "scan" }, { cwd: "/sess" }, "/d");
  check("省略號路徑 → truncated", r.reason === "truncated");
}

{
  const r = resolveDiffBase({ path: "src/.../a.ts", source: "scan" }, { cwd: "/sess" }, "/d");
  check("三點路徑 → truncated", r.reason === "truncated");
}

{
  const r = resolveDiffBase({ path: "   ", source: "scan" }, { cwd: "/sess" }, "/d");
  check("空白路徑 → unresolvable", r.reason === "unresolvable");
}

{
  const r = resolveDiffBase({ path: "a\nb.ts", source: "scan" }, { cwd: "/sess" }, "/d");
  check("含換行的路徑 → unresolvable", r.reason === "unresolvable");
}

{
  const r = resolveDiffBase({ path: "  src/a.ts  ", source: "scan" }, { cwd: "/sess" }, "/d");
  check("路徑前後空白被 trim", r.path === "src/a.ts");
}

console.log(`diff-target: ${passed} checks passed`);
