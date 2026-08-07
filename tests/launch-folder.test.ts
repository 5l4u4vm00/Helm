// Pure launch-folder helper tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/launch-folder.test.ts
import assert from "node:assert";
import {
  findWorkspaceByFolder,
  isSameFolder,
  normalizeFolderPath,
  workspaceNameForFolder,
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

console.log(`\nlaunch-folder: ${passed} checks passed`);
