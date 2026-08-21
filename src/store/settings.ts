// 終端機外觀與預設啟動參數，記在 localStorage（每個欄位各自一個 key）。
import { create } from "zustand";

export type CursorStyle = "block" | "bar" | "underline";

const DEFAULT_FONT_FAMILY =
  '"SF Mono", "Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", Menlo, Monaco, "Courier New", monospace';
const DEFAULT_FONT_SIZE = 13;
/** 字級範圍：setter 與 SettingsDialog 的 number input 共用同一組界線。 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

const DEFAULT_SCROLLBACK = 10000;
/** 回捲行數範圍：同上，setter 與 number input 共用。上限保護記憶體。 */
export const SCROLLBACK_MIN = 1000;
export const SCROLLBACK_MAX = 100000;

/** 側欄寬度（px）與範圍：setter 與拖曳把手共用同一組界線。下限保住狀態燈 +
 *  操作鍵仍可點，上限避免把終端機擠到不能用。 */
export const SIDEBAR_WIDTH_DEFAULT = 220;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;

/** 字型下拉選單的預設選項，value 為含備援字型的完整 CSS font-family 字串 */
export interface FontFamilyPreset {
  id: string;
  label: string;
  value: string;
}

export const FONT_FAMILY_PRESETS: FontFamilyPreset[] = [
  { id: "sf-mono", label: "SF Mono", value: DEFAULT_FONT_FAMILY },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    value: '"Cascadia Code", "Cascadia Mono", Consolas, "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "cascadia-mono",
    label: "Cascadia Mono",
    value: '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    value: '"JetBrains Mono", "SF Mono", Consolas, Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "fira-code",
    label: "Fira Code",
    value: '"Fira Code", "SF Mono", Consolas, Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    value: '"Source Code Pro", "SF Mono", Consolas, Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "menlo",
    label: "Menlo",
    value: 'Menlo, Monaco, "SF Mono", Consolas, "Courier New", monospace',
  },
  {
    id: "monaco",
    label: "Monaco",
    value: 'Monaco, Menlo, "SF Mono", Consolas, "Courier New", monospace',
  },
  {
    id: "consolas",
    label: "Consolas",
    value: 'Consolas, "Cascadia Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "courier-new",
    label: "Courier New",
    value: '"Courier New", Consolas, Menlo, Monaco, monospace',
  },
];
const DEFAULT_CURSOR_STYLE: CursorStyle = "block";
const DEFAULT_CURSOR_BLINK = true;

const KEYS = {
  fontFamily: "helm.fontFamily",
  fontSize: "helm.fontSize",
  cursorStyle: "helm.cursorStyle",
  cursorBlink: "helm.cursorBlink",
  scrollback: "helm.scrollback",
  sidebarWidth: "helm.sidebarWidth",
  defaultShell: "helm.defaultShell",
  defaultCwd: "helm.defaultCwd",
  notificationsEnabled: "helm.notificationsEnabled",
  notifyWaiting: "helm.notifyWaiting",
  notifyDone: "helm.notifyDone",
  notifyError: "helm.notifyError",
  notifyInterrupted: "helm.notifyInterrupted",
  notifyStalled: "helm.notifyStalled",
  notifyHiddenPanes: "helm.notifyHiddenPanes",
  restoreSessions: "helm.restoreSessions",
  restoreScrollback: "helm.restoreScrollback",
  resumeAgentsOnLaunch: "helm.resumeAgentsOnLaunch",
  backgroundImage: "helm.backgroundImage",
  backgroundDim: "helm.backgroundDim",
} as const;

const DEFAULT_BACKGROUND_DIM = 40;

interface SettingsState {
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  // 每個 session 保留的回捲行數；agent transcript 動輒上萬行，預設放寬到 10000。
  scrollback: number;
  // 側欄寬度（px）。agent 自動標題動輒 40 字元，預設 220px 只放得下一半，
  // 所以寬度是使用者偏好而非固定版面常數。
  sidebarWidth: number;
  defaultShell: string;
  defaultCwd: string;
  notificationsEnabled: boolean;
  // 桌面通知的類型開關（總開關 && 類型開關才發；通知中心不受影響、永遠記錄）。
  notifyWaiting: boolean; // 需要核准/回覆（approval / question / plan）
  notifyDone: boolean; // agent 回合完成
  notifyError: boolean; // agent 錯誤
  notifyInterrupted: boolean; // agent 工作中 PTY 死掉（被中斷）
  notifyStalled: boolean; // agent 停在忙碌但長時間無輸出
  // 視窗聚焦時，畫面外 pane（不在目前分割群組）的 waiting / error 仍發桌面通知。
  notifyHiddenPanes: boolean;
  // 重啟還原：session 清單 + 分割佈局（PTY 一律是新的，不會復活行程），
  // 以及每個 pane 的 scrollback 快照重播。
  restoreSessions: boolean;
  restoreScrollback: boolean;
  // 還原後自動對每個 agent pane 送出 resume 指令。預設關閉：一次 resume 8 個
  // pane 會燒 token、可能撞 rate limit，且目錄搬過就滿螢幕失敗訊息。
  resumeAgentsOnLaunch: boolean;
  // 自訂背景圖：檔案絕對路徑（""=無），與遮罩強度 0-100（越大畫面越暗，維持文字可讀）。
  backgroundImage: string;
  backgroundDim: number;
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setCursorStyle: (v: CursorStyle) => void;
  setCursorBlink: (v: boolean) => void;
  setScrollback: (v: number) => void;
  setSidebarWidth: (v: number) => void;
  setDefaultShell: (v: string) => void;
  setDefaultCwd: (v: string) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setNotifyWaiting: (v: boolean) => void;
  setNotifyDone: (v: boolean) => void;
  setNotifyError: (v: boolean) => void;
  setNotifyInterrupted: (v: boolean) => void;
  setNotifyStalled: (v: boolean) => void;
  setNotifyHiddenPanes: (v: boolean) => void;
  setRestoreSessions: (v: boolean) => void;
  setRestoreScrollback: (v: boolean) => void;
  setResumeAgentsOnLaunch: (v: boolean) => void;
  setBackgroundImage: (v: string) => void;
  setBackgroundDim: (v: number) => void;
}

function initialFontFamily(): string {
  return localStorage.getItem(KEYS.fontFamily) || DEFAULT_FONT_FAMILY;
}

function initialFontSize(): number {
  const v = Number(localStorage.getItem(KEYS.fontSize));
  return v > 0 ? v : DEFAULT_FONT_SIZE;
}

function initialCursorStyle(): CursorStyle {
  const v = localStorage.getItem(KEYS.cursorStyle);
  return v === "bar" || v === "underline" || v === "block" ? v : DEFAULT_CURSOR_STYLE;
}

function initialCursorBlink(): boolean {
  const v = localStorage.getItem(KEYS.cursorBlink);
  return v === null ? DEFAULT_CURSOR_BLINK : v === "true";
}

function initialScrollback(): number {
  const v = Number(localStorage.getItem(KEYS.scrollback));
  return Number.isFinite(v) && v >= SCROLLBACK_MIN && v <= SCROLLBACK_MAX
    ? v
    : DEFAULT_SCROLLBACK;
}

function initialSidebarWidth(): number {
  const v = Number(localStorage.getItem(KEYS.sidebarWidth));
  return Number.isFinite(v) && v >= SIDEBAR_WIDTH_MIN && v <= SIDEBAR_WIDTH_MAX
    ? v
    : SIDEBAR_WIDTH_DEFAULT;
}

function initialBool(key: string): boolean {
  const v = localStorage.getItem(key);
  return v === null ? true : v === "true";
}

/** 預設關閉的開關（沒寫過就是 false）。 */
function initialBoolOff(key: string): boolean {
  return localStorage.getItem(key) === "true";
}

function initialBackgroundDim(): number {
  const v = Number(localStorage.getItem(KEYS.backgroundDim));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_BACKGROUND_DIM;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  fontFamily: initialFontFamily(),
  fontSize: initialFontSize(),
  cursorStyle: initialCursorStyle(),
  cursorBlink: initialCursorBlink(),
  scrollback: initialScrollback(),
  sidebarWidth: initialSidebarWidth(),
  defaultShell: localStorage.getItem(KEYS.defaultShell) || "",
  defaultCwd: localStorage.getItem(KEYS.defaultCwd) || "",
  notificationsEnabled: initialBool(KEYS.notificationsEnabled),
  notifyWaiting: initialBool(KEYS.notifyWaiting),
  notifyDone: initialBool(KEYS.notifyDone),
  notifyError: initialBool(KEYS.notifyError),
  notifyInterrupted: initialBool(KEYS.notifyInterrupted),
  notifyStalled: initialBool(KEYS.notifyStalled),
  notifyHiddenPanes: initialBool(KEYS.notifyHiddenPanes),
  restoreSessions: initialBool(KEYS.restoreSessions),
  restoreScrollback: initialBool(KEYS.restoreScrollback),
  resumeAgentsOnLaunch: initialBoolOff(KEYS.resumeAgentsOnLaunch),
  backgroundImage: localStorage.getItem(KEYS.backgroundImage) || "",
  backgroundDim: initialBackgroundDim(),

  setFontFamily: (v) => {
    localStorage.setItem(KEYS.fontFamily, v);
    set({ fontFamily: v });
  },
  setFontSize: (v) => {
    // 界線防護：越界/NaN 不能寫進 localStorage 再套到 xterm。
    if (!Number.isFinite(v)) return;
    const size = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, v));
    localStorage.setItem(KEYS.fontSize, String(size));
    set({ fontSize: size });
  },
  setCursorStyle: (v) => {
    localStorage.setItem(KEYS.cursorStyle, v);
    set({ cursorStyle: v });
  },
  setCursorBlink: (v) => {
    localStorage.setItem(KEYS.cursorBlink, String(v));
    set({ cursorBlink: v });
  },
  setScrollback: (v) => {
    if (!Number.isFinite(v)) return;
    const lines = Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, v));
    localStorage.setItem(KEYS.scrollback, String(lines));
    set({ scrollback: lines });
  },
  // 拖曳把手會高頻呼叫：界線防護留在 setter 內，越界值不能寫進 localStorage。
  setSidebarWidth: (v) => {
    if (!Number.isFinite(v)) return;
    const width = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(v)));
    localStorage.setItem(KEYS.sidebarWidth, String(width));
    set({ sidebarWidth: width });
  },
  setDefaultShell: (v) => {
    localStorage.setItem(KEYS.defaultShell, v);
    set({ defaultShell: v });
  },
  setDefaultCwd: (v) => {
    localStorage.setItem(KEYS.defaultCwd, v);
    set({ defaultCwd: v });
  },
  setNotificationsEnabled: (v) => {
    localStorage.setItem(KEYS.notificationsEnabled, String(v));
    set({ notificationsEnabled: v });
  },
  setNotifyWaiting: (v) => {
    localStorage.setItem(KEYS.notifyWaiting, String(v));
    set({ notifyWaiting: v });
  },
  setNotifyDone: (v) => {
    localStorage.setItem(KEYS.notifyDone, String(v));
    set({ notifyDone: v });
  },
  setNotifyError: (v) => {
    localStorage.setItem(KEYS.notifyError, String(v));
    set({ notifyError: v });
  },
  setNotifyInterrupted: (v) => {
    localStorage.setItem(KEYS.notifyInterrupted, String(v));
    set({ notifyInterrupted: v });
  },
  setNotifyStalled: (v) => {
    localStorage.setItem(KEYS.notifyStalled, String(v));
    set({ notifyStalled: v });
  },
  setNotifyHiddenPanes: (v) => {
    localStorage.setItem(KEYS.notifyHiddenPanes, String(v));
    set({ notifyHiddenPanes: v });
  },
  setRestoreSessions: (v) => {
    localStorage.setItem(KEYS.restoreSessions, String(v));
    set({ restoreSessions: v });
  },
  setRestoreScrollback: (v) => {
    localStorage.setItem(KEYS.restoreScrollback, String(v));
    set({ restoreScrollback: v });
  },
  setResumeAgentsOnLaunch: (v) => {
    localStorage.setItem(KEYS.resumeAgentsOnLaunch, String(v));
    set({ resumeAgentsOnLaunch: v });
  },
  setBackgroundImage: (v) => {
    localStorage.setItem(KEYS.backgroundImage, v);
    set({ backgroundImage: v });
  },
  setBackgroundDim: (v) => {
    if (!Number.isFinite(v)) return;
    const dim = Math.min(100, Math.max(0, v));
    localStorage.setItem(KEYS.backgroundDim, String(dim));
    set({ backgroundDim: dim });
  },
}));
