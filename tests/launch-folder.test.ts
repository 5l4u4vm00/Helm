// Pure launch-folder helper tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/launch-folder.test.ts
import assert from "node:assert";
import {
  findWorkspaceByFolder,
  isSameFolder,
  normalizeFolderPath,
  workspaceNameForFolder,
  displayFolderPath,
} from "../src/store/launchFolder.ts";
import type { Workspace } from "../src/store/workspaceGroups.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

function ws(id: string, folder?: string): Workspace {
  return folder === undefined
    ? { id, name: id, collapsed: false }
    : { id, name: id, collapsed: false, folder };
}

// --- normalizeFolderPath ---
{
  console.log("normalizeFolderPath:");
  check(
    "反斜線轉正斜線",
    normalizeFolderPath("C:\\src\\helm", true) === "c:/src/helm",
  );
  check("去掉結尾斜線", normalizeFolderPath("/home/a/repo/", false) === "/home/a/repo");
  check(
    "去掉多個結尾斜線",
    normalizeFolderPath("/home/a/repo///", false) === "/home/a/repo",
  );
  check("Windows 大小寫不敏感", normalizeFolderPath("C:\\SRC\\Helm", true) === "c:/src/helm");
  check("Unix 保留大小寫", normalizeFolderPath("/home/A/Repo", false) === "/home/A/Repo");
  check("去除前後空白", normalizeFolderPath("  /home/a  ", false) === "/home/a");

  // Roots must not be stripped down to "" or "C:" — those are not directories.
  check("Unix 根目錄保留斜線", normalizeFolderPath("/", false) === "/");
  check("磁碟根目錄保留斜線", normalizeFolderPath("C:\\", true) === "c:/");
  check("磁碟根目錄無斜線也補回", normalizeFolderPath("C:", true) === "c:/");
}

// --- isSameFolder ---
{
  console.log("\nisSameFolder:");
  check(
    "同一路徑不同分隔符與大小寫（Windows）",
    isSameFolder("C:\\src\\helm", "c:/src/helm/", true),
  );
  check(
    "Unix 大小寫不同視為不同資料夾",
    !isSameFolder("/home/a/Repo", "/home/a/repo", false),
  );
  check("不同資料夾", !isSameFolder("/home/a", "/home/b", false));
  check(
    "前綴相同但非同一層不算相同",
    !isSameFolder("/home/a/repo", "/home/a/repo2", false),
  );
}

// --- findWorkspaceByFolder ---
{
  console.log("\nfindWorkspaceByFolder:");
  const list = [ws("default"), ws("a", "C:\\src\\api"), ws("b", "C:\\src\\web")];
  check(
    "找到已綁定同資料夾的 workspace",
    findWorkspaceByFolder(list, "c:/src/web/", true)?.id === "b",
  );
  check("沒綁定資料夾者不參與比對", findWorkspaceByFolder([ws("default")], "C:\\x", true) === undefined);
  check("找不到時回 undefined", findWorkspaceByFolder(list, "C:\\src\\other", true) === undefined);
  check(
    "重複綁定時取第一個（順序穩定）",
    findWorkspaceByFolder(
      [ws("a", "/x"), ws("b", "/x")],
      "/x",
      false,
    )?.id === "a",
  );
  check("空清單回 undefined", findWorkspaceByFolder([], "/x", false) === undefined);
}

// --- workspaceNameForFolder ---
{
  console.log("\nworkspaceNameForFolder:");
  check("取 Windows 路徑最後一段", workspaceNameForFolder("C:\\src\\helm") === "helm");
  check("取 Unix 路徑最後一段", workspaceNameForFolder("/home/a/repo") === "repo");
  check("忽略結尾斜線", workspaceNameForFolder("/home/a/repo/") === "repo");
  check("磁碟根目錄退回整串", workspaceNameForFolder("C:\\") === "C:");
  check("Unix 根目錄退回整串", workspaceNameForFolder("/") === "/");
  check("保留原本大小寫", workspaceNameForFolder("C:\\src\\MyApp") === "MyApp");
}

// --- displayFolderPath（側欄/差異標頭的路徑呈現：從**頭部**裁切） ---
{
  console.log("\ndisplayFolderPath:");
  check("在預算內原樣輸出", displayFolderPath("C:\\src\\helm", 30) === "C:\\src\\helm");
  check("剛好等於預算不裁切", displayFolderPath("0123456789", 10) === "0123456789");

  // 核心保證：尾段（資料夾名稱）一定看得到，而且順序不變 —— 這正是
  // direction: rtl 會弄壞的地方。
  const long = "C:\\Users\\USER\\Desktop\\richi\\Helm";
  const shown = displayFolderPath(long, 20);
  check("超長路徑會裁切", shown.length <= 20);
  check("保留結尾的資料夾名稱", shown.endsWith("Helm"));
  check("以省略號開頭（頭部被裁）", shown.startsWith("…"));
  check("維持原本的分隔符與順序（不像 rtl 會被重排）", shown === "…\\Desktop\\richi\\Helm");

  check(
    "Unix 路徑同樣從頭部裁",
    displayFolderPath("/home/user/projects/deep/nest/app", 20) === "…/deep/nest/app",
  );
  check(
    "切在分隔符上，不切在名稱中間",
    !/^…[^/\\]/.test(displayFolderPath("/aaaa/bbbb/cccc/dddd/eeee", 15)),
  );
  // 單一超長段落沒有分隔符可切 → 硬切，但仍保住結尾。
  const oneSegment = displayFolderPath("/" + "x".repeat(50) + "END", 10);
  check("無分隔符時硬切仍保住結尾", oneSegment.endsWith("END") && oneSegment.length <= 10);

  check("預算 <= 1 時原樣輸出（不做無意義的裁切）", displayFolderPath("/a/b/c", 1) === "/a/b/c");
  check("空字串安全", displayFolderPath("", 30) === "");

  // 預設預算（側欄 220px @10px）刻意保守：**寧可少顯示，也不能超寬** ——
  // 超寬時 CSS 會從尾端裁掉，等於把資料夾名稱丟了，正是本函式要防的事。
  const deep = "C:\\Users\\USER\\Desktop\\richi\\SomeVeryLongProjectFolder\\Helm";
  const def = displayFolderPath(deep);
  check("預設預算保住結尾資料夾名稱", def.endsWith("Helm"));
  check("預設預算不超過上限（超寬會被 CSS 從尾端裁掉）", def.length <= 30);
}

console.log(`\nlaunch-folder: ${passed} checks passed`);
