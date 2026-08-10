// 把拖進終端機的檔案路徑轉成「可以直接寫進 PTY 的一段文字」。
//
// 這一層完全是純函式，因為它決定的是**送進 shell 的字面內容**：引號漏一個，
// 使用者拖一個帶空白的路徑就會被 shell 拆成兩個參數；跳脫多一層，路徑就開不了。
// 兩種錯誤都只在真的拖了某個特定檔名時才出現，所以靠手測補不完，必須單元測。
//
// Helm 在這裡刻意只做 Windows Terminal 做的那件事：把加好引號的絕對路徑當成
// **鍵盤輸入**寫進 PTY，不送 Enter。CLI（Claude Code 等）看到的就只是使用者
// 打了一串路徑，要不要讀檔、怎麼讀，是 CLI 自己的事 —— Helm 不解讀檔案內容，
// 也不預設對方是哪個 agent。

/** 送進 PTY 前，路徑要用哪一套引號規則。 */
export type DropQuoting = "windows" | "posix";

// 這些字元出現在路徑裡時，未加引號的路徑會被 shell 重新解讀（分隔成多個參數、
// 展開變數、當成運算子）。空白是最常見的一個，但遠不只空白 —— `&` 在 cmd/
// PowerShell 是命令分隔符，`$` 在 POSIX 與 PowerShell 都會展開變數。
// 判斷「要不要引號」時一律從寬：多加引號永遠安全，少加才會出事。
const NEEDS_QUOTING = /[\s"'`$&|;<>()[\]{}*?!#~^,=%]/;

/**
 * 依平台規則把單一路徑包成一個 shell 參數。
 *
 * Windows：雙引號內幾乎所有字元都是字面值，只有 `"` 本身要處理 —— 反斜線在
 * 這裡**不是**跳脫字元（`C:\repo\` 的結尾反斜線必須原樣保留），所以絕不能套
 * POSIX 的 `\\` 加倍規則，那會把每個路徑分隔符都打壞。
 *
 * POSIX：單引號是唯一「內部完全不解讀」的引號，反斜線、`$`、`` ` `` 全是字面
 * 值；代價是單引號自己無法在裡面表示，得先關掉再用 `\'` 接一個，再開回來。
 */
export function quoteDropPath(path: string, quoting: DropQuoting): string {
  if (path === "") return "";
  if (quoting === "windows") {
    // 內嵌的 `"` 在 Windows 命令列以 `""` 表示；其餘（含反斜線）原樣保留。
    if (!NEEDS_QUOTING.test(path)) return path;
    return `"${path.replace(/"/g, '""')}"`;
  }
  if (!NEEDS_QUOTING.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * 多個路徑串成一行 PTY 輸入：各自加引號後以單一空白相接。
 *
 * 空白分隔是 shell 的參數慣例，也正是 CLI 接多個檔案時期待的形狀。空路徑
 * （理論上不該出現，但拖曳來源不可信）會被丟掉而不是變成一對空引號。
 */
export function formatDroppedPaths(paths: readonly string[], quoting: DropQuoting): string {
  return paths
    .filter((p) => p !== "")
    .map((p) => quoteDropPath(p, quoting))
    .join(" ");
}

/**
 * 寫進 PTY 前的最後一道防線：拿掉會被終端機當成控制訊號的字元。
 *
 * 檔名理論上不含這些字元，但路徑字串是從 OS 拖放事件來的外部輸入，而 PTY 對
 * 收到的每個位元組都照單全收 —— 一個混進去的 `\r` 會直接**送出這一行**，等於
 * 替使用者按了 Enter（我們刻意不送 Enter，就是不想替他決定何時執行）；`\x1b`
 * 則會被解讀成跳脫序列的開頭。兩者都是「拖一個檔案卻執行了東西」的路徑，
 * 所以在這裡剝掉，而不是信任來源。
 */
export function sanitizeDropText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * 拖放事件 → 要寫進 PTY 的完整字串（已加引號、已去控制字元）。
 * 回傳空字串代表「沒有東西可寫」，呼叫端應直接跳過而不是寫入空輸入。
 *
 * 清理**先於**引號判斷：控制字元自己會命中 NEEDS_QUOTING 的 `\s`，順序反過來的
 * 話，一個混進 `\r` 的乾淨路徑會被判定成「需要引號」，等控制字元被剝掉，那對引號
 * 卻留在原地 —— 結果仍然可用，但輸出取決於一個看不見的字元，不是我們要的確定性。
 */
export function buildDropInput(paths: readonly string[], quoting: DropQuoting): string {
  return formatDroppedPaths(paths.map(sanitizeDropText), quoting);
}
