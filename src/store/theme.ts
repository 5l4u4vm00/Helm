// 應用主題（多組配色 preset + 使用者自訂主題），記在 localStorage。
import { create } from "zustand";
import type { CSSProperties } from "react";
import type { ITheme } from "@xterm/xterm";

export type ThemeName =
  | "dark"
  | "light"
  | "solarized"
  | "nord"
  | "dracula"
  | "gruvbox"
  | "onedark"
  | "tokyonight"
  | "githubDark"
  | "githubLight";

export const THEME_NAMES: ThemeName[] = [
  "dark",
  "light",
  "solarized",
  "nord",
  "dracula",
  "gruvbox",
  "onedark",
  "tokyonight",
  "githubDark",
  "githubLight",
];

// dark/light 為通用名，SettingsDialog 以 THEME_LABEL_KEYS 走 i18n；此處僅作 fallback。
export const THEME_LABELS: Record<ThemeName, string> = {
  dark: "Dark",
  light: "Light",
  solarized: "Solarized Dark",
  nord: "Nord",
  dracula: "Dracula",
  gruvbox: "Gruvbox Dark",
  onedark: "One Dark",
  tokyonight: "Tokyo Night",
  githubDark: "GitHub Dark",
  githubLight: "GitHub Light",
};

// 使用者自訂主題：從當下主題複製為起點，UI 9 變數 + 終端 20 色全可調。
// id 以 "custom-" 開頭，直接作為 helm.theme 的值（與內建名共用同一欄位）。
export type UiColorKey =
  | "appBg"
  | "termBg"
  | "sidebarBg"
  | "border"
  | "fg"
  | "muted"
  | "hover"
  | "active"
  | "accent";

export const UI_COLOR_VARS: Record<UiColorKey, string> = {
  appBg: "--app-bg",
  termBg: "--term-bg",
  sidebarBg: "--sidebar-bg",
  border: "--border",
  fg: "--fg",
  muted: "--muted",
  hover: "--hover",
  active: "--active",
  accent: "--accent",
};

export interface CustomTheme {
  id: string;
  name: string;
  colorScheme: "dark" | "light";
  ui: Record<UiColorKey, string>;
  terminal: ITheme;
}

interface ThemeState {
  name: string; // 內建 ThemeName 或自訂主題 id
  customThemes: CustomTheme[];
  setName: (name: string) => void;
  toggle: () => void;
  createCustomTheme: (theme: Omit<CustomTheme, "id">) => string;
  updateCustomTheme: (id: string, patch: Partial<Omit<CustomTheme, "id">>) => void;
  deleteCustomTheme: (id: string) => void;
}

const STORAGE_KEY = "helm.theme";
const CUSTOM_STORAGE_KEY = "helm.customThemes";

function loadCustomThemes(): CustomTheme[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CUSTOM_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is CustomTheme =>
        !!c &&
        typeof c.id === "string" &&
        typeof c.name === "string" &&
        (c.colorScheme === "dark" || c.colorScheme === "light") &&
        typeof c.ui === "object" &&
        c.ui !== null &&
        typeof c.terminal === "object" &&
        c.terminal !== null,
    );
  } catch {
    return [];
  }
}

function saveCustomThemes(themes: CustomTheme[]) {
  localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(themes));
}

function initial(customThemes: CustomTheme[]): string {
  const v = localStorage.getItem(STORAGE_KEY);
  if (!v) return "dark";
  if (THEME_NAMES.includes(v as ThemeName)) return v;
  if (customThemes.some((c) => c.id === v)) return v;
  return "dark";
}

const initialCustomThemes = loadCustomThemes();

export const useThemeStore = create<ThemeState>((set, get) => ({
  name: initial(initialCustomThemes),
  customThemes: initialCustomThemes,
  setName: (name) => {
    localStorage.setItem(STORAGE_KEY, name);
    set({ name });
  },
  // 快速鍵用：僅在深/淺之間切換，Settings 對話框可選完整 preset 清單。
  toggle: () => {
    const next = get().name === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    set({ name: next });
  },
  createCustomTheme: (theme) => {
    const id = `custom-${crypto.randomUUID()}`;
    const customThemes = [...get().customThemes, { id, ...theme }];
    saveCustomThemes(customThemes);
    localStorage.setItem(STORAGE_KEY, id);
    set({ customThemes, name: id });
    return id;
  },
  updateCustomTheme: (id, patch) => {
    const customThemes = get().customThemes.map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    );
    saveCustomThemes(customThemes);
    set({ customThemes });
  },
  deleteCustomTheme: (id) => {
    const customThemes = get().customThemes.filter((c) => c.id !== id);
    saveCustomThemes(customThemes);
    if (get().name === id) {
      localStorage.setItem(STORAGE_KEY, "dark");
      set({ customThemes, name: "dark" });
    } else {
      set({ customThemes });
    }
  },
}));

/**
 * 依 active 名稱解析 xterm 主題：自訂 id → 其 terminal 色組，否則內建 preset。
 * transparentBg=true 時把背景設為全透明（配合 allowTransparency），讓 .app 的
 * 自訂背景圖（經 dim 遮罩調暗）透出終端；文字/ANSI 前景與 cell 背景照常繪製。
 */
export function resolveXtermTheme(
  name: string,
  customThemes: CustomTheme[],
  transparentBg = false,
): ITheme {
  const custom = customThemes.find((c) => c.id === name);
  const base = custom ? custom.terminal : xtermThemes[name as ThemeName] ?? xtermThemes.dark;
  return transparentBg ? { ...base, background: "rgba(0,0,0,0)" } : base;
}

/** 自訂主題的 UI 變數 → inline style（App.css 不需要 [data-theme="custom"] 區塊）。 */
export function customCssVars(theme: CustomTheme): CSSProperties {
  const style: Record<string, string> = {
    colorScheme: theme.colorScheme,
    // 背景圖遮罩的色相：淺色主題用白遮罩沖淡，深色用黑（同 App.css 內建主題）。
    "--app-bg-tint": theme.colorScheme === "light" ? "255, 255, 255" : "0, 0, 0",
  };
  for (const [key, cssVar] of Object.entries(UI_COLOR_VARS)) {
    style[cssVar] = theme.ui[key as UiColorKey];
  }
  return style as CSSProperties;
}

// xterm 對應的配色（含完整 16 色 ANSI palette，避免不同背景色下色彩衝突）。
export const xtermThemes: Record<ThemeName, ITheme> = {
  // Catppuccin Mocha
  dark: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selectionBackground: "#585b70",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  // Catppuccin Latte
  light: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#dc8a78",
    selectionBackground: "#acb0be",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#bcc0cc",
  },
  // 官方 Solarized Dark 16 色
  solarized: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  // 官方 Nord 16 色終端機 palette
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  // 官方 Dracula 16 色
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f0",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  // 官方 Gruvbox Dark 16 色
  gruvbox: {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  // One Dark Pro 標準終端機 palette
  onedark: {
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    selectionBackground: "#3e4451",
    black: "#3f4451",
    red: "#e05561",
    green: "#8cc265",
    yellow: "#d18f52",
    blue: "#4aa5f0",
    magenta: "#c162de",
    cyan: "#42b3c2",
    white: "#e6e6e6",
    brightBlack: "#4f5666",
    brightRed: "#ff616e",
    brightGreen: "#a5e075",
    brightYellow: "#f0a45d",
    brightBlue: "#4dc4ff",
    brightMagenta: "#de73ff",
    brightCyan: "#4cd1e0",
    brightWhite: "#e6e6e6",
  },
  // 官方 Tokyo Night 終端機 palette
  tokyonight: {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    selectionBackground: "#33467c",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  // GitHub Dark 終端機 palette
  githubDark: {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    selectionBackground: "#3392ff44",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
  // GitHub Light 終端機 palette
  githubLight: {
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#0969da",
    selectionBackground: "#0969da33",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};
