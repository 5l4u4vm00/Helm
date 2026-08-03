// Pane 內的搜尋列：只搜自己這個終端機的 buffer。
// 刻意渲染在 .xterm 之外(見 keyTarget.ts 的 isTextEntry)——在 .xterm 內的
// 輸入框會被判定為終端機而非文字欄位,Ctrl+A 就會變成 arm prefix 而非全選。
import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { handleDismissKey } from "../../focus/focusUtils";
import { useT } from "../../i18n";
import "./TerminalSearchBar.css";

interface Props {
  /** The pane's search addon; null while the terminal is still mounting. */
  search: SearchAddon | null;
  /** Close the bar and hand focus back to the terminal. */
  onClose: () => void;
}

export function TerminalSearchBar({ search, onClose }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState({ index: -1, count: 0 });

  useEffect(() => inputRef.current?.focus(), []);

  // resultIndex 是 0-based,-1 表示無結果。
  useEffect(() => {
    const d = search?.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResult({ index: resultIndex, count: resultCount }),
    );
    return () => d?.dispose();
  }, [search]);

  // 邊打邊找:incremental 讓已符合的區段不會在每次按鍵時跳走。清空輸入時
  // onDidChangeResults 不會再觸發,計數由 onChange 直接歸零。
  useEffect(() => {
    if (!search || query === "") return;
    search.findNext(query, { incremental: true, decorations: DECORATIONS });
  }, [query, search]);

  // 關閉時清掉高亮,否則殘留的標記會留在 buffer 上。
  useEffect(() => () => search?.clearDecorations(), [search]);

  const step = (back: boolean) => {
    if (!search || query === "") return;
    const opts = { decorations: DECORATIONS };
    if (back) search.findPrevious(query, opts);
    else search.findNext(query, opts);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (handleDismissKey(e, onClose)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey);
    }
  };

  const label =
    query === ""
      ? ""
      : result.count === 0
        ? t("terminal.search.noResults")
        : `${result.index + 1}/${result.count}`;

  return (
    <div className="term-search" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder={t("terminal.search.placeholder")}
        aria-label={t("terminal.search.label")}
        onChange={(e) => {
          const next = e.target.value;
          setQuery(next);
          if (next === "") {
            search?.clearDecorations();
            setResult({ index: -1, count: 0 });
          }
        }}
      />
      <span className="term-search-count">{label}</span>
      <button
        type="button"
        aria-label={t("terminal.search.close")}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

// 用主題無關的高對比色:xterm 的 decoration 直接畫在 cell 上,若沿用主題前景色
// 在淺色/深色主題其一會看不見。
const DECORATIONS = {
  matchBackground: "#613315",
  matchBorder: "#f0a35e",
  matchOverviewRuler: "#f0a35e",
  activeMatchBackground: "#a1670d",
  activeMatchBorder: "#ffd08a",
  activeMatchColorOverviewRuler: "#ffd08a",
};
