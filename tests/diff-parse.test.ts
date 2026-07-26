// Pure unified-diff parser tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/diff-parse.test.ts
import assert from "node:assert";
import { parseUnifiedDiff } from "../src/diff/parseUnifiedDiff.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// --- empty / malformed input ---
{
  const r = parseUnifiedDiff("");
  check("空輸入 → 空結果", r.hunks.length === 0 && r.added === 0 && r.removed === 0);
  check("空輸入不是 binary", !r.binary);
}

{
  const r = parseUnifiedDiff("diff --git a/x b/x\n@@ nonsense @@\n+lost\n");
  check("壞掉的 @@ → 跳過該 hunk 而非拋錯", r.hunks.length === 0);
  check("壞 hunk 內的行不計數", r.added === 0);
}

// --- a normal single-hunk edit ---
{
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,4 +10,5 @@ function demo() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
    "",
  ].join("\n");
  const r = parseUnifiedDiff(patch);
  check("單一 hunk", r.hunks.length === 1);
  check("計算增刪行數", r.added === 2 && r.removed === 1);
  check("擷取新舊路徑", r.oldPath === "src/a.ts" && r.newPath === "src/a.ts");
  check("擷取 hunk 章節標題", r.hunks[0].heading === "function demo() {");
  check("不是新增/刪除/改名", !r.isNew && !r.isDeleted && !r.isRename);

  const lines = r.hunks[0].lines;
  check("行數正確（3 context+add/del 混合共 5 行）", lines.length === 5);
  check("context 行同時有新舊行號", lines[0].oldNo === 10 && lines[0].newNo === 10);
  check("刪除行只有舊行號", lines[1].kind === "del" && lines[1].oldNo === 11 && lines[1].newNo === undefined);
  check("新增行只有新行號", lines[2].kind === "add" && lines[2].newNo === 11 && lines[2].oldNo === undefined);
  check("刪除後 context 的舊行號續接", lines[4].oldNo === 12 && lines[4].newNo === 13);
  check("行文字已去掉前綴字元", lines[2].text === "const b = 3;");
}

// --- new file (also the synthesized untracked patch shape) ---
{
  const r = parseUnifiedDiff("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  check("--- /dev/null → isNew", r.isNew);
  check("新檔案全部是 add", r.added === 2 && r.removed === 0);
  check("新檔案的 newPath", r.newPath === "new.txt");
}

// --- deleted file ---
{
  const r = parseUnifiedDiff(
    "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n",
  );
  check("+++ /dev/null → isDeleted", r.isDeleted);
  check("刪除檔案全部是 del", r.removed === 2 && r.added === 0);
}

// --- rename ---
{
  const r = parseUnifiedDiff(
    "diff --git a/old.ts b/new.ts\nsimilarity index 95%\nrename from old.ts\nrename to new.ts\n",
  );
  check("rename from/to → isRename", r.isRename);
}

// --- binary ---
{
  const r = parseUnifiedDiff("Binary files /dev/null and b/a.png differ\n");
  check("Binary files … differ → binary", r.binary);
}
{
  const r = parseUnifiedDiff("diff --git a/a.png b/a.png\nGIT binary patch\nliteral 100\n");
  check("GIT binary patch → binary", r.binary);
}

// --- multi-hunk ---
{
  const patch = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    "-a",
    "+b",
    " c",
    "@@ -20,2 +20,3 @@",
    " d",
    "+e",
    "",
  ].join("\n");
  const r = parseUnifiedDiff(patch);
  check("兩個 hunk", r.hunks.length === 2);
  check("第二個 hunk 從自己的起始行號算起", r.hunks[1].lines[0].oldNo === 20);
  check("跨 hunk 累計增刪", r.added === 2 && r.removed === 1);
}

// --- \ No newline at end of file ---
{
  const r = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
  check("反斜線標註不算一行", r.hunks[0].lines.length === 2);
  check("反斜線標註不計入增刪", r.added === 1 && r.removed === 1);
}

// --- CRLF ---
{
  const r = parseUnifiedDiff("--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n");
  check("CRLF 被正規化", r.added === 1 && r.removed === 1);
  check("CRLF 行文字不殘留 \\r", r.hunks[0].lines[1].text === "b");
}

// --- omitted counts (@@ -1 +1 @@ means 1 line) ---
{
  const r = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -5 +5 @@\n-a\n+b\n");
  check("省略行數的 @@ 仍能定位行號", r.hunks[0].lines[0].oldNo === 5);
}

console.log(`diff-parse: ${passed} checks passed`);
