// Pure launch-folder helper tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/launch-folder.test.ts
import assert from "node:assert";
import {
  findWorkspaceByFolder,
  isSameFolder,
  normalizeFolderPath,
  workspaceNameForFolder,
  displayFolderPath,
  middleEllipsis,
  sidebarCharBudget,
  workspaceNameBudget,
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


// --- middleEllipsis（workspace 名稱：頭尾都要保住） ---
{
  console.log("\nmiddleEllipsis:");
  check("在預算內原樣輸出", middleEllipsis("Backend", 20) === "Backend");
  check("剛好等於預算不裁切", middleEllipsis("0123456789", 10) === "0123456789");

  // 核心保證：頭尾都看得見 —— 這正是尾端 ellipsis 會弄丟的一半。
  const long = "Backend Services staging";
  const shown = middleEllipsis(long, 16);
  check("超長會裁切且不超過預算", shown.length <= 16);
  check("保住開頭", shown.startsWith("B"));
  check("保住結尾", shown.endsWith("g"));
  check("中間有省略號", shown.includes("…"));

  // 預算扣掉省略號後對半分，餘數給尾端（結尾通常是分支/環境等識別後綴）。
  check("奇數預算：尾端多一個字元", middleEllipsis("abcdefghij", 5) === "ab…ij");
  check("偶數預算", middleEllipsis("abcdefghij", 6) === "abc…ij");
  check("長度精準等於預算", middleEllipsis("abcdefghij", 7).length === 7);

  // 預算太小時整串幾乎只剩省略號，沒有意義 → 原樣輸出交給 CSS 尾端裁切。
  check("預算 < 5 原樣輸出", middleEllipsis("abcdefghij", 4) === "abcdefghij");
  check("空字串安全", middleEllipsis("", 10) === "");
  check("預算 5 是最小可用值", middleEllipsis("abcdefghij", 5).length === 5);
}

// --- sidebarCharBudget（側欄寬度 → 字元預算） ---
{
  console.log("\nsidebarCharBudget:");
  // 預設寬度換算出的預算要與原本寫死的 30 同量級，行為才不會突變。
  const atDefault = sidebarCharBudget(220);
  check("預設寬度 220px 的預算接近原本的 30", atDefault >= 28 && atDefault <= 38);

  check("越寬預算越大", sidebarCharBudget(480) > sidebarCharBudget(220));
  check("越窄預算越小", sidebarCharBudget(180) < sidebarCharBudget(220));

  // 下限：最窄的側欄也不能讓預算小到整串都是省略號。
  check("極窄寬度仍有下限", sidebarCharBudget(0) >= 12);
  check("負寬度仍有下限", sidebarCharBudget(-100) >= 12);
  check("NaN 回下限（不能把 NaN 傳進裁切邏輯）", sidebarCharBudget(NaN) === 12);
  check("輸出為整數", Number.isInteger(sidebarCharBudget(333)));

  // 名稱那行還要分給 chevron / 計數 / 徽章，預算必須比路徑行更緊 ——
  // 太鬆的話 CSS 會先從尾端裁掉，等於丟了 middleEllipsis 要保的後半段。
  check("名稱預算比路徑預算緊", workspaceNameBudget(220) < sidebarCharBudget(220));
  check("名稱預算同樣隨寬度成長", workspaceNameBudget(400) > workspaceNameBudget(220));
  // 下限必須 >= 5：middleEllipsis 在 max < 5 時原字串直接回傳，預算掉到 4 不是
  // 「裁得更兇」而是「完全不裁」，整個名稱會溢出交給 CSS 從尾端切。
  check("名稱預算下限不低於 middleEllipsis 的作用門檻", workspaceNameBudget(0) >= 5);
  check("最小側欄寬（含徽章）仍會實際中段省略", middleEllipsis("Workspace 2", workspaceNameBudget(180, 1)).includes("…"));
  check("NaN 回下限", workspaceNameBudget(NaN) === 12);

  // 平時就顯示的控制項（資料夾/啟動設定鍵著色後不隨 hover 消失、approval 徽章
  // 未處理前一直在）每顆佔 20px，會實際壓縮名稱可用寬度。
  check("常駐徽章讓預算變緊", workspaceNameBudget(220, 1) < workspaceNameBudget(220, 0));
  check("徽章數越多預算越緊", workspaceNameBudget(300, 2) < workspaceNameBudget(300, 1));
  check("徽章數為負視為 0", workspaceNameBudget(220, -3) === workspaceNameBudget(220, 0));

  // 實測不變式：名稱盒寬 = max(42px 下限, 側欄寬 - 124 - 20×徽章)，字體平均
  // 6.83px/字。42px 是 CSS 的 min-width，對應預算下限 5 個字元 —— 兩邊必須一致，
  // 否則最小寬度下預算比盒子寬，CSS 又會從尾端裁掉。
  for (const width of [180, 220, 260, 300, 400, 480]) {
    for (const badges of [0, 1, 2]) {
      const boxPx = Math.max(42, width - 124 - badges * 20);
      const holds = boxPx / 6.83;
      check(
        `預算不超過實際盒寬 (w=${width}, badges=${badges})`,
        workspaceNameBudget(width, badges) <= holds,
      );
    }
  }

  // 迴歸：220px 下這個名稱一定要被中段省略（原本因預算太鬆而被 CSS 尾裁）。
  const wsName = "Payments API integration staging";
  const shownName = middleEllipsis(wsName, workspaceNameBudget(220));
  check("220px 下長 workspace 名稱會中段省略", shownName.includes("…"));
  // 兩端都要留下東西 —— 這才是 middleEllipsis 存在的理由（尾裁會整段丟掉後半）。
  // 220px 只有 12 字元的預算，塞不下完整的 "staging"；後綴要完整得等側欄夠寬，
  // 所以完整後綴的斷言放在 260px 驗，220px 只驗「頭尾都還在」。
  check("中段省略後頭部仍可辨識", shownName.startsWith("Pay"));
  check("中段省略後仍保住結尾片段", shownName.endsWith("aging"));
  const wideName = middleEllipsis(wsName, workspaceNameBudget(260));
  check("側欄夠寬時保住完整的識別後綴", wideName.endsWith(" staging"));
}

console.log(`\nlaunch-folder: ${passed} checks passed`);
