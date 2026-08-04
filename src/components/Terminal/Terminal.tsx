// xterm.js 終端面板：掛載後開一條 PTY，串接輸入/輸出/resize。
// 多實例：隱藏時仍保留掛載（PTY 續跑、scrollback 保留），顯示時 refit。
// agent 感知：輸出後 debounce 讀取已渲染的 buffer 文字餵給 onScan。
import { memo, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import {
  onPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../../ipc/pty";
import { openExternalUrl } from "../../ipc/opener";
import { resolveXtermTheme, useThemeStore } from "../../store/theme";
import { decodeOsc52 } from "./osc52";
import { decodeOsc9 } from "./osc9";
import { useSettingsStore } from "../../store/settings";
import { SYMBOLS_NERD_FONT, withSymbolsFallback } from "../../store/fontFamily";
import { useUiStore } from "../../store/ui";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { focusActiveTerminal } from "../../focus/focusUtils";
import { t } from "../../i18n";
import "./Terminal.css";

// Agent-scan debounce. Hidden panes still scan (their approvals surface via
// sidebar badges and desktop notifications) but at a relaxed cadence — the
// extra latency is invisible there and the viewport regex sweep is not free.
const SCAN_DEBOUNCE_VISIBLE_MS = 150;
const SCAN_DEBOUNCE_HIDDEN_MS = 1000;

// Trailing refit delay after a pane-size change settles (see the ResizeObserver
// below). Long enough to outlast the macOS window zoom / full-screen animation.
const FIT_SETTLE_MS = 250;

interface TerminalProps {
  id: string;
  /** 是否為目前 focus 的 pane（邊框高亮 + 自動聚焦輸入）。 */
  focused: boolean;
  /** Pane is CSS-visible (`data-in-layout="true"`); drives refit on show. */
  visible: boolean;
  cwd?: string;
  shell?: string;
  /** 啟動後送進 PTY 的指令（例如啟動某個 agent）。 */
  launchCommand?: string;
  /** 是否需要 onStream 文字（session 有 agent 且 profile 有 extract）；
   *  false 時跳過每個 chunk 的 TextDecoder 解碼。 */
  streamEnabled: boolean;
  onTitle?: (title: string) => void;
  /** OSC 9 桌面通知序列（Codex tui.notifications 等）的訊息本文。 */
  onNotify?: (message: string) => void;
  onBusy?: () => void;
  onIdle?: () => void;
  onExit?: () => void;
  /** PTY 完全開不起來（連退回 home 都失敗）；此 pane 沒有任何行程。 */
  onSpawnError?: () => void;
  /** debounce 後把近期已渲染文字交出去做 agent 狀態偵測。 */
  onScan?: (text: string) => void;
  /** 原始輸出串流（已解碼文字），供逐行擷取成本/檔案變更。 */
  onStream?: (text: string) => void;
}

// 只讀「目前可見畫面」的渲染文字（baseY 起算的 term.rows 行）。
// 刻意不含捲動歷史：已回答並捲走的提示不該再被當成作用中的核准。
function readBufferText(term: XTerm): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    if (line) out.push(line.translateToString(true));
  }
  return out.join("\n");
}

function TerminalImpl({
  id,
  focused,
  visible,
  cwd,
  shell,
  launchCommand,
  streamEnabled,
  onTitle,
  onNotify,
  onBusy,
  onIdle,
  onExit,
  onSpawnError,
  onScan,
  onStream,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // State (not a ref): the search bar must re-render once the addon exists.
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
  const themeName = useThemeStore((s) => s.name);
  const customThemes = useThemeStore((s) => s.customThemes);
  // 有自訂背景圖時終端底色改為透明，讓背景圖透出（見 resolveXtermTheme / App.css）。
  const bgImageActive = useSettingsStore((s) => !!s.backgroundImage);

  const cbRef = useRef({
    onTitle, onNotify, onBusy, onIdle, onExit, onSpawnError, onScan, onStream,
  });
  // Latest-ref 模式（刻意在 render 期同步更新）：PTY 事件可能在 render 與
  // effect flush 之間到達，改在 effect 內指派會讀到過期 callback。
  // eslint-disable-next-line react-hooks/refs
  cbRef.current = {
    onTitle, onNotify, onBusy, onIdle, onExit, onSpawnError, onScan, onStream,
  };

  // Renderer: xterm 5.x + the canvas addon (DOM renderer as fallback). xterm
  // 6.x rendered full-screen TUIs (nvim's alternate screen) blank on macOS
  // WKWebView regardless of WebGL/DOM renderer or forced repaints; 5.x + canvas
  // is the WKWebView-proven stack. If loadAddon throws, xterm keeps its
  // built-in DOM renderer.
  const visibleRef = useRef(visible);
  // Latest-ref 模式（同 cbRef）：scan debounce 在事件路徑上讀取，不參與 render。
  // eslint-disable-next-line react-hooks/refs
  visibleRef.current = visible;
  // Latest-ref 模式（同 cbRef）：PTY 輸出 callback 讀取。被動偵測到 agent 時
  // 旗標才翻 true，memo comparator 必須比對 streamEnabled 才能刷新此 ref。
  const streamEnabledRef = useRef(streamEnabled);
  // eslint-disable-next-line react-hooks/refs
  streamEnabledRef.current = streamEnabled;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const settings = useSettingsStore.getState();
    const term = new XTerm({
      fontFamily: withSymbolsFallback(settings.fontFamily),
      fontSize: settings.fontSize,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      allowTransparency: true,
      theme: resolveXtermTheme(
        useThemeStore.getState().name,
        useThemeStore.getState().customThemes,
        !!settings.backgroundImage,
      ),
    });
    // xterm.js 不對映 Ctrl+/ → 0x1F(^_);補上讓 nvim 的 <C-/> 綁定可用。
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey &&
        e.key === "/"
      ) {
        term.input("\x1f");
        return false; // 已處理,不讓 xterm 預設邏輯再碰
      }
      // Ctrl+C 有選取時複製（同 Windows Terminal）；沒選取時落回 xterm 預設
      // 送出 SIGINT(0x03)。複製後清掉選取,下次 Ctrl+C 即回到中斷行為。
      if (
        e.type === "keydown" &&
        e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey &&
        e.key === "c" && term.hasSelection()
      ) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Unicode 11 寬度表(CJK 全形、emoji)必須在 open() 之前生效,否則首次
    // 量測會用內建的 v6 表,中文/emoji 會算錯欄寬導致游標錯位。
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
    } catch {
      /* keep xterm's built-in v6 width tables */
    }
    term.open(container);
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* fall back to the built-in DOM renderer */
    }
    // 終端機輸出是不可信內容,連結一律交給 openExternalUrl 過濾 scheme 後
    // 用系統瀏覽器開啟(window.open 會開在 webview 內)。
    try {
      term.loadAddon(new WebLinksAddon((_event, uri) => void openExternalUrl(uri)));
    } catch {
      /* URLs stay as plain text */
    }
    const searchAddonInstance = new SearchAddon();
    term.loadAddon(searchAddonInstance);
    setSearchAddon(searchAddonInstance);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    // PTY 尺寸的唯一同步點:任何 fit() 路徑(ResizeObserver、alt-screen 切換、
    // 字型載入/變更、visible/focus refit)只要實際改變格子數就會經 onResize
    // 傳到 PTY,不會再有「xterm 變大了但 PTY 停在舊 rows」的脫鉤(mac 冷啟動
    // 首開 Claude Code 高度不滿版即此因)。拖曳分隔線時 fit 連發:尾端
    // debounce,拖曳結束才通知 PTY。spawn 完成前不送(session 尚未註冊),
    // spawn 後的權威同步會補上最新尺寸。
    let spawned = false;
    let ptyResizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
      ptyResizeTimer = setTimeout(() => {
        if (spawned) void ptyResize(id, cols, rows);
      }, 80);
    });

    const titleDisposable = term.onTitleChange((t) => cbRef.current.onTitle?.(t));

    // OSC 9（桌面通知）：Codex 設了 [tui] 的 notification_method = "osc9" 後，
    // 會以 `\x1b]9;<訊息>\x07` 通知審批/回合結束，訊息交給 onNotify 推導狀態。
    // decodeOsc9 會先濾掉 ConEmu / Windows Terminal 的進度子命令（9;1～9;4），
    // 否則那些會被當成「回合結束」而誤報 done（見 osc9.ts）。
    // 忽略時仍回 true：沒有其他 OSC 9 consumer，xterm 對 OSC 9 也沒有內建行為，
    // 回 false 只會落入 unhandled 路徑產生雜訊（與下方 OSC 52 的 `?` 查詢同慣例）。
    const oscDisposable = term.parser.registerOscHandler(9, (data) => {
      const text = decodeOsc9(data);
      if (text !== null) cbRef.current.onNotify?.(text);
      return true;
    });

    // OSC 52（剪貼簿）：nvim/tmux 等 TUI 以 `\x1b]52;c;<base64>\x07` 要求
    // 終端機把 yank 內容寫進系統剪貼簿。只支援寫入，查詢（`?`）刻意不回應。
    const osc52Disposable = term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data);
      if (text !== null) void navigator.clipboard.writeText(text);
      return true;
    });

    // Switching to/from the alternate screen (nvim and other full-screen TUIs)
    // can change the usable cell grid; refit on the swap so cols/rows stay
    // correct.
    const bufferDisposable = term.buffer.onBufferChange(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          /* ignore */
        }
      });
    });

    // 活動燈 + agent 掃描（皆 debounce）。
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    const onOutput = () => {
      // Leading-edge busy: onBusy fires once per busy period (first chunk),
      // not per chunk — the idle timeout re-arms it.
      if (idleTimer === undefined) cbRef.current.onBusy?.();
      else clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        cbRef.current.onIdle?.();
      }, 400);
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(
        () => {
          cbRef.current.onScan?.(readBufferText(term));
        },
        visibleRef.current ? SCAN_DEBOUNCE_VISIBLE_MS : SCAN_DEBOUNCE_HIDDEN_MS,
      );
    };

    let disposed = false;
    let unlistenExit: UnlistenFn | undefined;
    let decoder = new TextDecoder();
    let streamWasEnabled = false;

    // The bundled symbols font (@font-face) loads asynchronously; the canvas
    // renderer builds its glyph atlas at open, so on a cold start the Nerd Font
    // icons would be blank until the next repaint. Force-load it, then drop the
    // stale atlas, refit (cell metrics may differ from the pre-load fit; any
    // grid change reaches the PTY via onResize) and repaint so icons appear
    // immediately.
    void document.fonts.load(`${settings.fontSize}px ${SYMBOLS_NERD_FONT}`).then(() => {
      if (disposed) return;
      try {
        term.clearTextureAtlas();
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch {
        /* ignore */
      }
    });

    const effectiveShell = shell ?? (settings.defaultShell || undefined);
    const effectiveCwd = cwd ?? (settings.defaultCwd || undefined);
    // Only *report* spawn failures under Tauri: in browser-only `npm run dev`
    // every invoke rejects, and painting three error lines into every pane
    // would be pure noise. Deliberately not an early return before spawning —
    // one false negative from isTauri() would leave a packaged build with no
    // PTY at all.
    const reportErrors = isTauri();

    const spawnPty = (spawnCwd: string | undefined) =>
      ptySpawn(
        { id, cols: term.cols, rows: term.rows, cwd: spawnCwd, shell: effectiveShell },
        (bytes) => {
          // The channel has no unlisten: a message can land between React
          // cleanup and the Rust reader noticing pty_kill, and term.write on
          // a disposed xterm would throw.
          if (disposed) return;
          term.write(bytes);
          onOutput();
          // 串流解碼供逐行擷取（stream:true 處理跨 chunk 的多位元組字元），
          // 只在需要時做：無 agent 的 session 解碼結果會被 handleStream 丟棄。
          // 旗標升起（被動偵測到 agent）時重建 decoder，丟棄停用期間可能殘留
          // 的跨 chunk 狀態；首個 chunk 若始於多位元組字元中段最多產生一個
          // 替換字元，usage/fileChange 行都在啟用之後才出現，實際無影響。
          if (streamEnabledRef.current) {
            if (!streamWasEnabled) {
              streamWasEnabled = true;
              decoder = new TextDecoder();
            }
            cbRef.current.onStream?.(decoder.decode(bytes, { stream: true }));
          } else {
            streamWasEnabled = false;
          }
        },
      );

    (async () => {
      // A listen() rejection means "no Tauri runtime", not a spawn failure —
      // it must not divert us into the error path below.
      unlistenExit = await onPtyExit(id, () => {
        term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        cbRef.current.onExit?.();
      }).catch(() => undefined);
      if (disposed) return;

      // A persisted workspace folder can point at an unmounted volume or a
      // directory that has since been moved, and pty.rs then fails the whole
      // spawn. Retry in the home directory so the pane is at least a usable
      // shell, but deliberately do NOT run launchCommand there: starting an
      // agent in the wrong directory silently points it at the wrong repo.
      let launched = true;
      try {
        await spawnPty(effectiveCwd);
      } catch (err) {
        if (disposed) return;
        if (!effectiveCwd) throw err;
        if (reportErrors) {
          term.write(`\r\n\x1b[33m${t("terminal.cwdFailed", { cwd: effectiveCwd })}\x1b[0m\r\n`);
          term.write(`\x1b[2m${String(err)}\x1b[0m\r\n`);
        }
        launched = false;
        await spawnPty(undefined);
      }
      if (disposed) return;
      // 權威同步:spawn（IPC 往返）期間的格子變化此前送不進 PTY,現在補上。
      spawned = true;
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
      void ptyResize(id, term.cols, term.rows);
      // 啟動 agent：把指令當作使用者輸入送進 PTY（保留完整 shell 環境）。
      if (launchCommand && launched) {
        await ptyWrite(id, `${launchCommand}\r`);
      } else if (launchCommand && reportErrors) {
        term.write(
          `\x1b[2m${t("terminal.launchSkipped", { command: launchCommand })}\x1b[0m\r\n`,
        );
      }
    })().catch((err) => {
      if (disposed) return;
      if (!reportErrors) return;
      term.write(`\r\n\x1b[31m${t("terminal.spawnFailed")}\x1b[0m\r\n`);
      term.write(`\x1b[2m${String(err)}\x1b[0m\r\n`);
      cbRef.current.onSpawnError?.();
    });

    const dataDisposable = term.onData((data) => {
      void ptyWrite(id, data);
    });

    // 拖曳分隔線時 resize 事件連發：fit 用 rAF 合併（畫面即時跟手），
    // PTY 的 cols/rows 由 onResize 的尾端 debounce 通知（見上方同步點）。
    let fitRaf = 0;
    // 尾端再補一次 fit：macOS 放大/全螢幕（視窗尺寸動畫）期間 renderer 量到的
    // cell 高度可能還是過渡值，那一幀的 fit 會少算列數；動畫結束後 pane 尺寸不
    // 再變，ResizeObserver 不會再觸發，錯誤列數就永久留下（grid 比 pane 矮，被
    // .terminal-pane 的垂直置中攤成上下留白）。fit() 在尺寸相同時是 no-op，
    // 所以這一發只在真的需要補正時才動到 xterm/PTY。
    let fitSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      if (!fitRaf) {
        fitRaf = requestAnimationFrame(() => {
          fitRaf = 0;
          try {
            fitAddon.fit();
          } catch {
            /* ignore */
          }
        });
      }
      if (fitSettleTimer) clearTimeout(fitSettleTimer);
      fitSettleTimer = setTimeout(() => {
        try {
          fitAddon.fit();
        } catch {
          /* ignore */
        }
      }, FIT_SETTLE_MS);
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (scanTimer) clearTimeout(scanTimer);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (fitSettleTimer) clearTimeout(fitSettleTimer);
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
      resizeObserver.disconnect();
      resizeDisposable.dispose();
      titleDisposable.dispose();
      oscDisposable.dispose();
      osc52Disposable.dispose();
      bufferDisposable.dispose();
      dataDisposable.dispose();
      unlistenExit?.();
      setSearchAddon(null);
      void ptyKill(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id, cwd, shell, launchCommand]);

  // focus 時聚焦輸入並 refit（版面剛變動時尺寸可能剛更新）。
  useEffect(() => {
    if (!focused) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        term.focus();
      } catch {
        /* ignore */
      }
    });
  }, [focused]);

  // Visible ⇢ refit (display just flipped from none; dimensions are valid by
  // rAF time). The DOM renderer needs no attach/detach across visibility.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = resolveXtermTheme(themeName, customThemes, bgImageActive);
  }, [themeName, customThemes, bgImageActive]);

  // 只有「正在搜尋的那個 session」顯示搜尋列;關閉時把焦點還給終端機。
  const searchOpen = useUiStore((s) => s.searchSessionId === id);
  const closeSearch = () => {
    useUiStore.getState().setSearchSessionId(null);
    focusActiveTerminal();
  };

  // 回捲行數變更：自成一個 effect。改 scrollback 不影響 cell 尺寸,不需要
  // 字型那條路徑的 clearTextureAtlas()/fit()/refresh() 重繪成本。
  const scrollback = useSettingsStore((s) => s.scrollback);
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.scrollback = scrollback;
  }, [scrollback]);

  // 字型/游標設定變更：套用到已存在的 term，並重新 fit（字型大小會改變 cell 尺寸）。
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const cursorStyle = useSettingsStore((s) => s.cursorStyle);
  const cursorBlink = useSettingsStore((s) => s.cursorBlink);
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontFamily = withSymbolsFallback(fontFamily);
    term.options.fontSize = fontSize;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    try {
      // Drop the canvas renderer's cached glyph atlas so the new font is
      // redrawn. Changing only fontFamily (same size) leaves cols/rows
      // unchanged, so fit() is a no-op and the stale glyphs would otherwise
      // stay on screen — "picked a font, nothing changed" on macOS.
      term.clearTextureAtlas();
      fit.fit();
      // Force a repaint of the visible rows even when dimensions didn't change.
      term.refresh(0, term.rows - 1);
    } catch {
      /* ignore */
    }
  }, [fontFamily, fontSize, cursorStyle, cursorBlink]);

  // 版面（single/grid、顯示與否）由外層 pane 控制；這裡只填滿容器。
  // 搜尋列是 containerRef 的 sibling:xterm 會把自己掛進 containerRef,
  // 放進去會落在 .xterm 內而讓 Ctrl+A 被判成終端機輸入(見 keyTarget.ts)。
  return (
    <div className="terminal-pane">
      <div className="terminal-host" ref={containerRef} />
      {searchOpen && (
        <TerminalSearchBar search={searchAddon} onClose={closeSearch} />
      )}
    </div>
  );
}

// The comparator ignores the callback props on purpose: they are read through
// cbRef (refreshed on every actual render), and the parent Pane's callbacks
// capture only the stable session id — so a skipped render can never leave a
// stale callback behind, while parent re-renders with fresh closures no
// longer cascade into every mounted terminal. streamEnabled is also read via
// a ref on the event path, but it MUST participate here: skipping the render
// would leave streamEnabledRef stale and stream extraction permanently off.
export const Terminal = memo(
  TerminalImpl,
  (prev, next) =>
    prev.id === next.id &&
    prev.focused === next.focused &&
    prev.visible === next.visible &&
    prev.cwd === next.cwd &&
    prev.shell === next.shell &&
    prev.launchCommand === next.launchCommand &&
    prev.streamEnabled === next.streamEnabled,
);
