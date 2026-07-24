import { lazy, memo, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Terminal } from "./components/Terminal/Terminal";
import { SessionSidebar } from "./components/SessionSidebar/SessionSidebar";
import { ApprovalPanel } from "./components/ApprovalPanel/ApprovalPanel";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { ChangedFilesPanel } from "./components/ChangedFilesPanel/ChangedFilesPanel";
import { NotificationCenter } from "./components/NotificationCenter/NotificationCenter";
import { IntegrationHint } from "./components/IntegrationHint/IntegrationHint";
import { PaneLabel } from "./components/PaneLabel/PaneLabel";
import { SplitResizers } from "./components/SplitLayout/SplitResizers";
import { notifyPendingPrompt, useSessionStore, type Session } from "./store/sessions";
import {
  clearApprovalSuppress,
  isApprovalSuppressed,
  markApprovalAnswered,
} from "./store/approvalSuppress";
import {
  STREAM_MAX_LINES_PER_CHUNK,
  bumpEmptyScanStreak,
  bumpNonWaitingStreak,
  clearHookWaiting,
  clearScanState,
  consumeLines,
  getTitleSignal,
  hasHookWaiting,
  isHookWaitingFresh,
  markHookWaiting,
  resetEmptyScanStreak,
  resetNonWaitingStreak,
  setTitleSignal,
} from "./store/scanState";
import { customCssVars, useThemeStore } from "./store/theme";
import { useSettingsStore } from "./store/settings";
import { groupTreeOf, useLayoutStore } from "./store/layout";
import { computeLayout, type RectPct } from "./store/layoutTree";
import { useUiStore } from "./store/ui";
import { matchBinding } from "./commands/keymap";
import { resolvePrefixInput } from "./commands/prefix";
import { usePrefixStore } from "./store/prefix";
import { WhichKey } from "./components/WhichKey/WhichKey";
import { runCommand } from "./commands/registry";
import { listen } from "@tauri-apps/api/event";
import { readImageDataUrl } from "./ipc/background";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activateSession } from "./commands/actions";
import { setMenuLanguage } from "./ipc/menu";
import { checkForUpdate } from "./ipc/update";
import { useUpdateStore } from "./store/update";
import { useLanguageStore } from "./store/language";
import { initRegistry, detectNotifyProfile, detectProfile, getProfile } from "./agents/registry";
import { deriveNotifySignal, deriveState, deriveTitleSignal, stripAnsi } from "./agents/engine";
import { normalizeHookPayload, profileIdForSource } from "./agents/hookEvents";
import { listenAgentHook } from "./ipc/hooks";
import { extractFilesFromText, extractFromLine, extractUsageFromText } from "./agents/extract";
import { useT } from "./i18n";
import "./App.css";

// 只在整個 app 生命週期做一次啟動流程。
let bootstrapped = false;

// 啟動時檢查更新；找到新版本只記錄下來提示使用者決定，不自動下載安裝。
async function checkForUpdateOnStartup(): Promise<void> {
  const { setPhase, setAvailable } = useUpdateStore.getState();
  setPhase("checking");
  const update = await checkForUpdate();
  if (!update) {
    setPhase("up-to-date");
    return;
  }
  setAvailable(update);
}

// Palette and settings live behind lazy() so their code stays out of the
// startup chunk; first open pays a one-time local chunk load. Both also
// self-gate on their ui-store flag, so mount-gating here is behavior-neutral.
const CommandPalette = lazy(() =>
  import("./components/CommandPalette/CommandPalette").then((m) => ({
    default: m.CommandPalette,
  })),
);
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  })),
);

function LazyOverlays() {
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  return (
    <Suspense fallback={null}>
      {paletteOpen && <CommandPalette />}
      {settingsOpen && <SettingsDialog />}
    </Suspense>
  );
}

// 未分組 session 的全幅 rect（與群組 leaf rect 走同一條 inline style 路徑）。
const FULL_RECT: RectPct = { top: 0, left: 0, width: 100, height: 100 };

// leaf rect（百分比）→ pane 的 inline style。
function rectStyle(rect: RectPct): CSSProperties {
  return {
    top: `${rect.top}%`,
    left: `${rect.left}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}

// 終端標題（OSC 0/2）→ 側欄標題 + 忙/靜止訊號。CLI 忙碌時以 spinner 字元
// 開頭更新標題、靜止時換成固定字元（見 builtins 的 title patterns），比 TUI
// 文字掃描可靠。訊號只記下來：標題變更本身就是 PTY 輸出，scan debounce 必然
// 跟著觸發，於下一次 handleScan（≤150ms）併入 deriveState。
function handleTitle(id: string, title: string) {
  const store = useSessionStore.getState();
  store.setTitle(id, title);
  const sess = store.sessions.find((x) => x.id === id);
  if (!sess?.agentId) return;
  const signal = deriveTitleSignal(getProfile(sess.agentId), title);
  setTitleSignal(id, signal, Date.now());
}

// OSC 9 桌面通知（Codex tui.notifications）→ 狀態訊號。發通知的 agent 只在
// 「要審批」與「回合結束」時發通知，waiting 前綴未命中即視為 done。session
// 尚未偵測到 agent 時，只有特異的 waiting 前綴兼作辨識；任意程式發的其他
// OSC 9 通知不動狀態。
function handleNotify(id: string, message: string) {
  const store = useSessionStore.getState();
  const sess = store.sessions.find((x) => x.id === id);
  if (!sess) return;
  let profileId = sess.agentId;
  if (!profileId) {
    const p = detectNotifyProfile(message);
    if (!p) return;
    store.setDetectedAgent(id, p.id, p.label);
    profileId = p.id;
  }
  const sig = deriveNotifySignal(getProfile(profileId), message);
  if (!sig) return;
  if (sig.state === "waiting") {
    markHookWaiting(id, Date.now());
    store.setAgentState(id, "waiting", sig.prompt, "approval");
  } else {
    clearHookWaiting(id);
    store.setAgentState(id, "done");
  }
}

// Hook 事件（agent://hook，見 src-tauri/src/hookserver.rs）→ 正規化 → store。
// 官方結構化訊號：permission/stop 直接設 waiting/done（比 viewport 掃描精確且
// 即時），usage/toolDone 更新統計。未安裝 hooks 時本函式不會被觸發，一切照舊。
function handleHookEvent(id: string, source: string, payload: unknown) {
  const store = useSessionStore.getState();
  const sess = store.sessions.find((x) => x.id === id);
  if (!sess) return;
  // source 直接確定 profile（比 detectOutput 被動偵測可靠）。
  const profileId = profileIdForSource(source);
  if (profileId && !sess.agentId) {
    const p = getProfile(profileId);
    store.setDetectedAgent(id, p.id, p.label);
  }
  const ev = normalizeHookPayload(source, payload);
  if (!ev) return;
  switch (ev.kind) {
    case "permission":
      markHookWaiting(id, Date.now());
      store.setAgentState(id, "waiting", ev.prompt, "approval");
      break;
    case "stop":
      clearHookWaiting(id);
      store.setAgentState(id, "done");
      break;
    case "toolDone":
      // 工具已執行 = 這次審批已被回答（核准）；狀態燈交回 scan 驅動。
      clearHookWaiting(id);
      if (ev.file) store.addChangedFile(id, ev.file);
      break;
    case "usage":
      store.setUsage(id, ev.usage);
      break;
  }
}

// 近期渲染文字 → 偵測 agent 並推導狀態，更新 store。
function handleScan(id: string, text: string) {
  const store = useSessionStore.getState();
  const sess = store.sessions.find((x) => x.id === id);
  if (!sess) {
    clearScanState(id);
    clearApprovalSuppress(id);
    return;
  }
  let profileId = sess.agentId;
  if (!profileId) {
    const p = detectProfile(text);
    if (!p) return;
    store.setDetectedAgent(id, p.id, p.label);
    profileId = p.id;
  }
  const profile = getProfile(profileId);
  // 用量統計（cost/tokens）與檔案變更從已渲染的 viewport 擷取：Claude Code 的
  // TUI（2.1+ 為 alt-screen）以游標移動原地重繪、幾乎沒有換行，stream 的逐行
  // 路徑看不到 footer 也看不到 ⏺ Update(...) 工具行。
  // 必須在下方 waiting/suppress 的早期 return 之前執行，否則審批期間統計會凍結。
  if (profile.extract) {
    const usage = extractUsageFromText(profile, text);
    if (
      usage.cost !== undefined ||
      usage.tokensIn !== undefined ||
      usage.tokensOut !== undefined ||
      usage.contextLeftPercent !== undefined
    ) {
      store.setUsage(id, usage);
    }
    for (const f of extractFilesFromText(profile, text)) store.addChangedFile(id, f);
  }
  const derived = deriveState(profile, text, getTitleSignal(id, Date.now()));
  if (derived.state) resetEmptyScanStreak(id);
  if (derived.state === "waiting") {
    // Just-answered prompt still on screen (TUI mid-repaint): don't resurrect
    // the prompt the user already responded to. A different prompt passes.
    if (isApprovalSuppressed(id, derived.prompt ?? "", Date.now())) {
      return;
    }
    resetNonWaitingStreak(id);
    // 目前的 waiting 來自 hook：prompt（tool_name + tool_input）比 viewport
    // 選單行精確，scan 只確認 waiting 持續，不覆蓋提示內容。
    if (hasHookWaiting(id) && sess.agentState === "waiting") return;
    store.setAgentState(id, derived.state, derived.prompt, derived.kind);
    return;
  }
  // Pending prompt (approval or question/plan) + non-waiting result: drop the
  // first divergent scan as a possibly-stale redraw frame; apply only on the
  // second consecutive one. This delays clearing, never setting, so real
  // prompts are unaffected.
  const pendingText = sess.pendingApproval ?? sess.pendingPrompt?.text;
  if (pendingText) {
    // Hook 剛宣告 waiting：對話框可能還沒重繪到 viewport，寬限期內不清除。
    if (isHookWaitingFresh(id, Date.now())) return;
    if (bumpNonWaitingStreak(id) < 2) return;
    // The dialog left the screen without a panel response — the user answered
    // inside the terminal. Record it so a stale copy of the same prompt
    // resurfacing (e.g. a resize reflow) cannot resurrect the prompt,
    // matching the explicit-response path in respondApproval.
    markApprovalAnswered(id, pendingText, Date.now());
    clearHookWaiting(id); // 審批結束，waiting 的 hook 來源標記一併失效
  }
  resetNonWaitingStreak(id);
  if (derived.state) {
    store.setAgentState(id, derived.state, derived.prompt);
  } else if (pendingText) {
    store.clearApproval(id);
  } else if (sess.agentState !== undefined && bumpEmptyScanStreak(id) >= 2) {
    // No pattern matched twice in a row: the agent quit back to the shell.
    // Clear the stale agentState so the dot falls back to the activity status.
    resetEmptyScanStreak(id);
    store.clearApproval(id);
  }
}

// 原始輸出串流 → 逐行擷取成本/用量/檔案變更。
function handleStream(id: string, text: string) {
  const store = useSessionStore.getState();
  const sess = store.sessions.find((x) => x.id === id);
  if (!sess) {
    clearScanState(id);
    return;
  }
  if (!sess.agentId) return;
  const profile = getProfile(sess.agentId);
  if (!profile.extract) return;

  // onStream 在 PTY data callback 內同步執行：行數上限擋住洪水輸出把逐行
  // 擷取的固定成本放大到卡住繪製（見 STREAM_MAX_LINES_PER_CHUNK 的取捨說明）。
  for (const raw of consumeLines(id, text, STREAM_MAX_LINES_PER_CHUNK)) {
    const line = stripAnsi(raw);
    if (!line.trim()) continue;
    const ex = extractFromLine(profile, line);
    if (
      ex.cost !== undefined ||
      ex.tokensIn !== undefined ||
      ex.tokensOut !== undefined ||
      ex.contextLeftPercent !== undefined
    ) {
      store.setUsage(id, {
        cost: ex.cost,
        tokensIn: ex.tokensIn,
        tokensOut: ex.tokensOut,
        contextLeftPercent: ex.contextLeftPercent,
      });
    }
    if (ex.file) store.addChangedFile(id, ex.file);
  }
}

// One tiled pane (label + terminal). Memoized so a store tick touching one
// session re-renders only that session's pane: `session` refs are stable for
// untouched sessions (store setters spread only the target) and `rect` refs
// are stable while the layout tree is unchanged. Every callback lives here
// and captures only the stable session id, module handlers, or store actions
// resolved at call time — keeping Terminal's memo comparator safe.
interface PaneProps {
  session: Session;
  rect: RectPct | undefined;
  active: boolean;
  solo: boolean;
}

const Pane = memo(function Pane({ session: s, rect, active, solo }: PaneProps) {
  // 沒有 agent（或 profile 無 extract）的 session 不需要 stream 文字：
  // Terminal 據此跳過每個 chunk 的 TextDecoder 解碼（handleStream 反正會丟棄）。
  const streamEnabled = s.agentId !== null && !!getProfile(s.agentId).extract;
  return (
    <div
      className={`pane ${active ? "focused" : ""}`}
      data-active={active}
      data-in-layout={rect ? "true" : "false"}
      data-solo={solo}
      style={rect ? rectStyle(rect) : undefined}
      onMouseDown={() => useSessionStore.getState().setActive(s.id)}
    >
      <PaneLabel session={s} />
      <Terminal
        id={s.id}
        focused={active}
        visible={rect !== undefined}
        cwd={s.cwd}
        launchCommand={s.launchCommand}
        streamEnabled={streamEnabled}
        onTitle={(title) => handleTitle(s.id, title)}
        onNotify={(message) => handleNotify(s.id, message)}
        onBusy={() => useSessionStore.getState().setStatus(s.id, "busy")}
        onIdle={() => useSessionStore.getState().setStatus(s.id, "idle")}
        onExit={() => {
          // Clear any leftover agent state so dotClass falls through to the
          // "exited" status dot (agentState takes precedence over status).
          useSessionStore.getState().clearApproval(s.id);
          useSessionStore.getState().setStatus(s.id, "exited");
        }}
        onScan={(text) => handleScan(s.id, text)}
        onStream={(text) => handleStream(s.id, text)}
      />
    </div>
  );
});

function App() {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const sidebarHidden = useUiStore((s) => s.sidebarHidden);
  const theme = useThemeStore((s) => s.name);
  // 自訂主題：data-theme 落到 "custom"（App.css 無此區塊），9 個 UI 變數以 inline style 提供。
  const customTheme = useThemeStore((s) => s.customThemes.find((c) => c.id === s.name));
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundDim = useSettingsStore((s) => s.backgroundDim);
  const trees = useLayoutStore((s) => s.trees);
  // 只渲染 active session 所在群組的樹；其他 session 的 pane 拿不到
  // rect → data-in-layout="false" 隱藏（Terminal 保持掛載）。
  // active session 未分組時 layoutRoot 為 null → 該 pane 拿全幅 rect。
  const layoutRoot = groupTreeOf(trees, activeId);

  // 群組樹 → 每個 leaf 的百分比 rect + 分隔線幾何。
  const layout = useMemo(
    () =>
      layoutRoot
        ? computeLayout(layoutRoot)
        : { leaves: new Map<string, RectPct>(), resizers: [] },
    [layoutRoot],
  );

  // 全域快捷鍵：tmux 風格 prefix（Ctrl+A）狀態機優先，pass 才落回 KEYMAP
  // 直接綁定（現在只剩 ⌘⇧P）。capture phase：搶在 xterm 的按鍵處理之前，
  // 武裝後的第二鍵無論比中與否都吞掉（tmux 行為），絕不進入終端。
  // 注意：macOS WKWebView 會在原生層吞掉部分 Cmd 組合鍵（實測 ⌘D 到不了 DOM，
  // 選單 accelerator 在 webview 有焦點時也不會觸發）——prefix 用 Ctrl 開頭
  // 沒有這個問題；選單項（見 lib.rs）提供可發現性與滑鼠入口。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return; // IME 組字中不介入
      const { armed, arm, disarm } = usePrefixStore.getState();
      const action = resolvePrefixInput(armed, e);
      if (action.type !== "pass") {
        e.preventDefault();
        e.stopPropagation();
        if (action.type === "arm") {
          arm();
        } else if (action.type === "run") {
          disarm();
          runCommand(action.commandId);
        } else if (action.type === "cancel") {
          disarm();
        }
        // "ignore"（單獨修飾鍵）：吞掉、保持武裝。
        return;
      }
      const id = matchBinding(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(id);
    };
    // 切走視窗（Cmd+Tab、點選單列）時解除武裝，避免回來時吃掉第一個按鍵。
    const onBlur = () => usePrefixStore.getState().disarm();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (bootstrapped) return;
    bootstrapped = true;
    (async () => {
      await initRegistry();
      // 啟動時把已持久化的語言同步給原生選單（Rust 端預設建置為 zh-TW）。
      void setMenuLanguage(useLanguageStore.getState().name);
      // 原生選單 accelerator → 命令派發（純瀏覽器環境會 reject，忽略）。
      listen<string>("app://shortcut", (e) => runCommand(e.payload)).catch(() => {});
      // CLI agent 的 hook 程序回報的結構化事件（審批/回合結束/用量）。
      listenAgentHook((e) => handleHookEvent(e.sessionId, e.source, e.payload)).catch(
        () => {},
      );
      // 點擊桌面通知（Rust 端送出）→ 聚焦視窗並切到觸發的 session。
      listen<string>("notify://activate", (e) => {
        const win = getCurrentWindow();
        void win.unminimize();
        void win.setFocus();
        activateSession(e.payload);
      }).catch(() => {});
      // Notifications are suppressed while the window is focused (the
      // ApprovalPanel is visible then); on blur, send them for prompts
      // still pending. Dedupe in notifyPendingPrompt stops alt-tab spam.
      window.addEventListener("blur", () => {
        for (const s of useSessionStore.getState().sessions) {
          notifyPendingPrompt(s);
        }
      });
      // 每次啟動都是全新配置：一個預設 workspace + 一個新 session。
      useSessionStore.getState().createSession();
      void checkForUpdateOnStartup();
    })();
  }, []);

  // 自訂背景圖：由 Rust 讀檔轉成 data: URL（不走 asset protocol，避開其 scope 限制、
  // 外接磁碟也能讀）；只把路徑存進 localStorage，data URL 僅存在記憶體、每次啟動重載。
  const [bgUrl, setBgUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = backgroundImage
      ? readImageDataUrl(backgroundImage)
      : Promise.resolve("");
    load
      .then((url) => {
        if (!cancelled) setBgUrl(url);
      })
      .catch((e) => {
        console.error("load background image failed", e);
        if (!cancelled) setBgUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [backgroundImage]);

  // 遮罩 0-100 → 0-1 alpha。
  const appStyle: CSSProperties = {
    ...(customTheme ? customCssVars(customTheme) : {}),
    ...(bgUrl
      ? ({
          "--app-bg-image": `url("${bgUrl}")`,
          "--app-bg-dim": String(backgroundDim / 100),
        } as CSSProperties)
      : {}),
  };

  return (
    <div
      className="app"
      data-theme={customTheme ? "custom" : theme}
      data-bg-image={bgUrl ? "true" : undefined}
      style={appStyle}
    >
      {!sidebarHidden && <SessionSidebar />}
      <main className="app-body">
        <Toolbar />
        {/* 同一組 pane 始終掛載；可見性只靠 data 屬性 + inline style 切換，避免重建終端。
            群組樹只算幾何，rect 以 inline style 套在平鋪 pane 上（不在群組中的隱藏）；
            未分組的 active session 拿全幅 rect（data-solo 只去除邊框，標題列一律顯示）。 */}
        <div className="terminal-area" data-focus-region="terminal">
          {sessions.map((s) => {
            const rect =
              layout.leaves.get(s.id) ??
              (layoutRoot === null && s.id === activeId ? FULL_RECT : undefined);
            return (
              <Pane
                key={s.id}
                session={s}
                rect={rect}
                active={s.id === activeId}
                solo={layoutRoot === null && s.id === activeId}
              />
            );
          })}
          {layoutRoot !== null && <SplitResizers resizers={layout.resizers} />}
          {sessions.length === 0 && (
            <div className="empty-hint">{t("app.emptyHint")}</div>
          )}
          <ApprovalPanel />
          <ChangedFilesPanel />
          <NotificationCenter />
          <IntegrationHint />
        </div>
      </main>
      <WhichKey />
      <LazyOverlays />
    </div>
  );
}

export default App;
