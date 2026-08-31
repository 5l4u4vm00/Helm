// 「這個容器可以 fit 了嗎？」的純判斷（純函式，node 測試可直接載入）。
//
// 為什麼值得獨立成一個模組：這個判斷在 Terminal.tsx 有 **三個** 呼叫端 ——
// open() 之後的首次 fit、ResizeObserver、以及重播前的 waitForWidth —— 而三者
// 必須用同一套定義。歷史上不是：waitForWidth 只檢查 clientWidth、漏了
// clientHeight，另外兩處都檢查兩者。那個不一致就是 bug 本體。
//
// ⚠️ 寬與高都要看，缺一不可。.terminal-pane 是 flex: 1 1 auto 且 min-height: 0
// （那行是必要的，讓終端機能在剩餘空間內縮放），所以冷啟動時 pane 的寬度會先
// 定下來、高度晚一拍才定 —— 中間存在一段 width > 0 && height === 0 的視窗期。
// 在那一刻 fit() 會以 0 高度算出最小列數（並連帶把 cols 也算小），接著重播的裸
// write 就把斷行永久烙進 buffer，之後再 fit 也救不回（症狀：shell 被擠在左側
// 細長一條、輸入的游標黏在最上方）。WebView2 的首幀佈局比 WKWebView 慢，這段
// 視窗期在 Windows 上明顯更寬；ConPTY 又不像 Unix PTY 會在 SIGWINCH 後由 shell
// 自行重畫，錯的 rows 會一直留著。
//
// 刻意收「兩個數字」而不是 HTMLElement：這樣本模組完全不依賴 DOM，node 測試能
// 直接載入（同 scanRows.ts / dropTarget.ts 的分工）。
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。

/** 一個容器的可用尺寸（對應 element 的 clientWidth / clientHeight）。 */
export interface BoxSize {
  width: number;
  height: number;
}

/**
 * 這個尺寸能不能安全地餵給 FitAddon.fit()。
 *
 * 只有「寬與高都是正數」才算可以。0 尺寸（display:none 的 pane、還沒完成佈局的
 * 冷啟動首幀）下 fit() 正是把格子夾成最小值的那一步，所以一律不做。
 *
 * 非有限值（NaN / Infinity）與負數一併擋掉：clientWidth 理論上不會是這些，但
 * 這個判斷的整個價值在於「不確定時不要 fit」，放寬只會把風險還給呼叫端。
 */
export function canFit(box: BoxSize): boolean {
  return (
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}
