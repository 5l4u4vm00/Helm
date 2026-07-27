// 設定對話框：主題、字型、游標、預設 shell/工作目錄。所有變更即時套用並寫入 localStorage。
// 結構仿 CommandPalette：backdrop + 置中對話框，Esc/backdrop 點擊關閉並還原焦點。
// 內容分四個分頁（一般 / 外觀 / Agent 整合 / 關於），分頁狀態僅存在元件內、不持久化。
import { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { ITheme } from "@xterm/xterm";
import { useUiStore } from "../../store/ui";
import {
  useThemeStore,
  THEME_NAMES,
  THEME_LABELS,
  UI_COLOR_VARS,
  resolveXtermTheme,
  type ThemeName,
  type UiColorKey,
} from "../../store/theme";
import {
  useSettingsStore,
  FONT_FAMILY_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type CursorStyle,
} from "../../store/settings";
import { firstFontFamily, toFontFamilyValue } from "../../store/fontFamily";
import { pickImage } from "../../ipc/dialog";
import { listMonospaceFonts } from "../../ipc/fonts";
import {
  installClaudeHooks,
  installClaudeStatusline,
  integrationStatus,
  type IntegrationStatus,
} from "../../ipc/integrations";
import {
  notificationStatus,
  openNotificationSettings,
  type NotificationStatus,
} from "../../ipc/notify";
import { useLanguageStore, LANGUAGE_NAMES, LANGUAGE_LABELS } from "../../store/language";
import { installPendingUpdate, useUpdateStore } from "../../store/update";
import { focusActiveTerminal, handleDismissKey, trapTabKey } from "../../focus/focusUtils";
import { useT } from "../../i18n";
import "./SettingsDialog.css";

type SettingsTab = "general" | "appearance" | "integrations" | "about";

const SETTINGS_TABS: { id: SettingsTab; labelKey: string }[] = [
  { id: "general", labelKey: "settings.tabGeneral" },
  { id: "appearance", labelKey: "settings.tabAppearance" },
  { id: "integrations", labelKey: "settings.tabIntegrations" },
  { id: "about", labelKey: "settings.tabAbout" },
];

const CURSOR_STYLE_KEYS: Record<CursorStyle, string> = {
  block: "settings.cursorStyleBlock",
  bar: "settings.cursorStyleBar",
  underline: "settings.cursorStyleUnderline",
};
const CURSOR_STYLES: CursorStyle[] = ["block", "bar", "underline"];

// dark/light 是通用名（非專有名詞），標籤走 i18n；其餘用 THEME_LABELS 的英文名。
const THEME_LABEL_KEYS: Partial<Record<ThemeName, string>> = {
  dark: "settings.themeDark",
  light: "settings.themeLight",
};

const CUSTOM_FONT_FAMILY_ID = "custom";

// 自訂主題編輯器的欄位定義（順序即顯示順序）。
const UI_COLOR_FIELDS: { key: UiColorKey; labelKey: string }[] = [
  { key: "appBg", labelKey: "settings.themeColorAppBg" },
  { key: "termBg", labelKey: "settings.themeColorTermBg" },
  { key: "sidebarBg", labelKey: "settings.themeColorSidebarBg" },
  { key: "border", labelKey: "settings.themeColorBorder" },
  { key: "fg", labelKey: "settings.themeColorFg" },
  { key: "muted", labelKey: "settings.themeColorMuted" },
  { key: "hover", labelKey: "settings.themeColorHover" },
  { key: "active", labelKey: "settings.themeColorActive" },
  { key: "accent", labelKey: "settings.themeColorAccent" },
];

type TerminalColorKey = Exclude<keyof ITheme, "extendedAnsi">;

const TERMINAL_COLOR_FIELDS: { key: TerminalColorKey; labelKey: string }[] = [
  { key: "background", labelKey: "settings.themeColorXtermBg" },
  { key: "foreground", labelKey: "settings.themeColorXtermFg" },
  { key: "cursor", labelKey: "settings.themeColorXtermCursor" },
  { key: "selectionBackground", labelKey: "settings.themeColorXtermSelection" },
];

// ANSI 標準色名固定用英文，不進 i18n。
const ANSI_COLOR_FIELDS: { key: TerminalColorKey; label: string }[] = [
  { key: "black", label: "Black" },
  { key: "red", label: "Red" },
  { key: "green", label: "Green" },
  { key: "yellow", label: "Yellow" },
  { key: "blue", label: "Blue" },
  { key: "magenta", label: "Magenta" },
  { key: "cyan", label: "Cyan" },
  { key: "white", label: "White" },
  { key: "brightBlack", label: "Bright Black" },
  { key: "brightRed", label: "Bright Red" },
  { key: "brightGreen", label: "Bright Green" },
  { key: "brightYellow", label: "Bright Yellow" },
  { key: "brightBlue", label: "Bright Blue" },
  { key: "brightMagenta", label: "Bright Magenta" },
  { key: "brightCyan", label: "Bright Cyan" },
  { key: "brightWhite", label: "Bright White" },
];

// <input type="color"> 只接受 #rrggbb：展開 #rgb、截掉 alpha（如 githubDark 的
// selectionBackground #3392ff44）、rgb() 形式轉 hex。
function normalizeHex(value: string): string {
  const v = value.trim();
  const rgb = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) {
    return `#${rgb
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  if (/^#[0-9a-f]{3,4}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{6}/i.test(v)) return v.slice(0, 7).toLowerCase();
  return "#000000";
}

// Codex 開啟 OSC 9 通知所需的 config.toml 片段（Helm 不自動改寫 TOML，
// 由使用者複製貼上；預設 auto 只對白名單終端發 OSC 9、且 focused 時不發）。
const CODEX_OSC9_SNIPPET = `[tui]
notification_method = "osc9"
notification_condition = "always"`;

// Agent 整合分頁：查詢/一鍵安裝 Claude Code hooks 與 statusline 轉發，
// Codex 顯示可複製的 config 片段。純瀏覽器環境（查無狀態）不顯示。
function IntegrationSection() {
  const t = useT();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void integrationStatus().then(setStatus);
  }, []);
  if (!status) return null;

  const install = (fn: () => Promise<void>) => {
    setError(null);
    fn()
      .then(() => integrationStatus().then(setStatus))
      .catch((e) => setError(String(e)));
  };

  return (
    <>
      <p className="settings-hint">{t("settings.integrationsHint")}</p>

      <div className="settings-row">
        <span title={t("settings.integrationClaudeHooksHint")}>
          {t("settings.integrationClaudeHooks")}
        </span>
        {status.claudeHooks ? (
          <span>{t("settings.integrationInstalled")}</span>
        ) : (
          <button
            className="settings-update-install"
            title={t("settings.integrationClaudeHooksHint")}
            onClick={() => install(installClaudeHooks)}
          >
            {t("settings.integrationInstall")}
          </button>
        )}
      </div>

      <div className="settings-row">
        <span title={t("settings.integrationClaudeHooksHint")}>
          {t("settings.integrationClaudeStatusline")}
        </span>
        {status.claudeStatusline === "helm" ? (
          <span>{t("settings.integrationInstalled")}</span>
        ) : status.claudeStatusline === "other" ? (
          <span>{t("settings.integrationManual")}</span>
        ) : (
          <button
            className="settings-update-install"
            title={t("settings.integrationClaudeHooksHint")}
            onClick={() => install(installClaudeStatusline)}
          >
            {t("settings.integrationInstall")}
          </button>
        )}
      </div>

      <div className="settings-row">
        <span>{t("settings.integrationCodexOsc9")}</span>
        {status.codexOsc9 ? (
          <span>{t("settings.integrationConfigured")}</span>
        ) : (
          <button
            className="settings-update-install"
            onClick={() => {
              void navigator.clipboard.writeText(CODEX_OSC9_SNIPPET);
              setCopied(true);
            }}
          >
            {copied ? t("settings.integrationCopied") : t("settings.integrationCopy")}
          </button>
        )}
      </div>
      {!status.codexOsc9 && (
        <>
          <p className="settings-hint">{t("settings.integrationCodexHint")}</p>
          <pre className="settings-snippet">{CODEX_OSC9_SNIPPET}</pre>
        </>
      )}

      {error && <p className="settings-error">{error}</p>}
    </>
  );
}

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsDialogInner />;
}

function SettingsDialogInner() {
  const t = useT();
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const prevFocusRef = useRef<Element | null>(document.activeElement);

  const [tab, setTab] = useState<SettingsTab>("general");

  const themeName = useThemeStore((s) => s.name);
  const setThemeName = useThemeStore((s) => s.setName);
  const customThemes = useThemeStore((s) => s.customThemes);
  const createCustomTheme = useThemeStore((s) => s.createCustomTheme);
  const updateCustomTheme = useThemeStore((s) => s.updateCustomTheme);
  const deleteCustomTheme = useThemeStore((s) => s.deleteCustomTheme);
  const customTheme = customThemes.find((c) => c.id === themeName);

  // 以當下主題為起點建立自訂主題：UI 9 變數從 .app 的 computed style 讀
  // （單一事實來源在 App.css / inline style，不在 TS 重複維護一份），終端色
  // 複製解析後的 xterm 主題。建立後自動切換為 active。
  const createCustomFromCurrent = () => {
    const app = document.querySelector(".app");
    if (!app) return;
    const cs = getComputedStyle(app);
    const ui = Object.fromEntries(
      (Object.entries(UI_COLOR_VARS) as [UiColorKey, string][]).map(([key, cssVar]) => [
        key,
        normalizeHex(cs.getPropertyValue(cssVar)),
      ]),
    ) as Record<UiColorKey, string>;
    const terminal = Object.fromEntries(
      Object.entries(resolveXtermTheme(themeName, customThemes)).map(([key, value]) => [
        key,
        normalizeHex(String(value)),
      ]),
    ) as ITheme;
    createCustomTheme({
      name: t("settings.themeCustomDefaultName", { n: customThemes.length + 1 }),
      colorScheme: cs.getPropertyValue("color-scheme").trim() === "light" ? "light" : "dark",
      ui,
      terminal,
    });
  };

  const language = useLanguageStore((s) => s.name);
  const setLanguage = useLanguageStore((s) => s.setName);

  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const cursorStyle = useSettingsStore((s) => s.cursorStyle);
  const cursorBlink = useSettingsStore((s) => s.cursorBlink);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const defaultCwd = useSettingsStore((s) => s.defaultCwd);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const notifyWaiting = useSettingsStore((s) => s.notifyWaiting);
  const notifyDone = useSettingsStore((s) => s.notifyDone);
  const notifyError = useSettingsStore((s) => s.notifyError);
  const notifyHiddenPanes = useSettingsStore((s) => s.notifyHiddenPanes);
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundDim = useSettingsStore((s) => s.backgroundDim);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setCursorStyle = useSettingsStore((s) => s.setCursorStyle);
  const setCursorBlink = useSettingsStore((s) => s.setCursorBlink);
  const setDefaultShell = useSettingsStore((s) => s.setDefaultShell);
  const setDefaultCwd = useSettingsStore((s) => s.setDefaultCwd);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const setNotifyWaiting = useSettingsStore((s) => s.setNotifyWaiting);
  const setNotifyDone = useSettingsStore((s) => s.setNotifyDone);
  const setNotifyError = useSettingsStore((s) => s.setNotifyError);
  const setNotifyHiddenPanes = useSettingsStore((s) => s.setNotifyHiddenPanes);
  const setBackgroundImage = useSettingsStore((s) => s.setBackgroundImage);
  const setBackgroundDim = useSettingsStore((s) => s.setBackgroundDim);

  // 通知後端狀態：macOS 授權失敗或 dev 模式時退回 osascript（通知歸屬
  // Script Editor、點擊無法聚焦 Helm），在總開關下方顯示警告與修復入口。
  const [notifStatus, setNotifStatus] = useState<NotificationStatus | null>(null);
  useEffect(() => {
    let alive = true;
    notificationStatus().then((status) => {
      if (alive) {
        setNotifStatus(status);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // 系統等寬字型清單；載入中(null)、清單為空或純瀏覽器環境時退回內建 preset。
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    listMonospaceFonts().then((fonts) => {
      if (alive) {
        setSystemFonts(fonts);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const fontOptions = useMemo(
    () =>
      systemFonts && systemFonts.length > 0
        ? systemFonts.map((name) => ({
            id: name,
            label: name,
            value: toFontFamilyValue(name),
          }))
        : FONT_FAMILY_PRESETS,
    [systemFonts],
  );

  // 使用者主動選了「自訂…」時強制顯示自由輸入框（此時 fontFamily 可能仍匹配某個選項）。
  const [forceCustomFont, setForceCustomFont] = useState(false);

  // 選中判定：先精確比對，再以第一個字型名稱比對（讓舊的 preset 備援鏈值
  // 能對到同名的系統字型），都沒中才落到「自訂」。
  const storedFirstFamily = firstFontFamily(fontFamily).toLowerCase();
  const selectedFontPresetId = forceCustomFont
    ? CUSTOM_FONT_FAMILY_ID
    : fontOptions.find((p) => p.value === fontFamily)?.id ??
      fontOptions.find((p) => firstFontFamily(p.value).toLowerCase() === storedFirstFamily)?.id ??
      CUSTOM_FONT_FAMILY_ID;

  const updatePhase = useUpdateStore((s) => s.phase);
  const updateVersion = useUpdateStore((s) => s.version);
  const [appVersion, setAppVersion] = useState("");

  // 開啟與切換分頁時，focus 目前分頁的第一個控件。
  useEffect(() => {
    const body = document.querySelector("#settings-dialog .settings-body");
    (body?.querySelector("select, input, button") as HTMLElement | null)?.focus();
  }, [tab]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const close = () => {
    setSettingsOpen(false);
    const prev = prevFocusRef.current;
    if (prev instanceof HTMLElement && prev.isConnected) {
      prev.focus();
    } else {
      focusActiveTerminal();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (handleDismissKey(e, close)) {
      return;
    } else if (e.key === "Tab") {
      trapTabKey(e, e.currentTarget as HTMLElement);
    }
  };

  return (
    <div className="settings-overlay">
      <div className="settings-backdrop" onClick={close} />
      <div
        id="settings-dialog"
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.dialogLabel")}
        onKeyDown={onKeyDown}
      >
        <div className="settings-header">
          <span className="settings-title">{t("settings.title")}</span>
          <button className="settings-close" onClick={close} aria-label={t("settings.close")}>
            ×
          </button>
        </div>

        <div className="settings-tabs" role="tablist">
          {SETTINGS_TABS.map(({ id, labelKey }) => (
            <button
              key={id}
              className="settings-tab"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "general" && (
            <>
              <label className="settings-row">
                <span>{t("settings.language")}</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as typeof language)}
                >
                  {LANGUAGE_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {LANGUAGE_LABELS[name]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row">
                <span>{t("settings.notifications")}</span>
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={(e) => setNotificationsEnabled(e.target.checked)}
                />
              </label>

              {/* macOS fallback 警告：osascript 通知點擊無法聚焦 Helm。 */}
              {notifStatus?.backend === "fallback" && (
                <div className="settings-subrow settings-notify-warning">
                  <span>
                    {notifStatus.bundled
                      ? t("settings.notifyFallbackWarning", {
                          reason: notifStatus.reason ?? t("settings.notifyFallbackUnknown"),
                        })
                      : t("settings.notifyFallbackDev")}
                  </span>
                  {notifStatus.bundled && (
                    <button
                      className="settings-secondary"
                      onClick={() => openNotificationSettings()}
                    >
                      {t("settings.openSystemSettings")}
                    </button>
                  )}
                </div>
              )}

              {/* 類型子開關：總開關關閉時停用（桌面通知全不發，通知中心仍記錄）。 */}
              <label className="settings-row settings-subrow">
                <span>{t("settings.notifyWaiting")}</span>
                <input
                  type="checkbox"
                  checked={notifyWaiting}
                  disabled={!notificationsEnabled}
                  onChange={(e) => setNotifyWaiting(e.target.checked)}
                />
              </label>
              <label className="settings-row settings-subrow">
                <span>{t("settings.notifyDone")}</span>
                <input
                  type="checkbox"
                  checked={notifyDone}
                  disabled={!notificationsEnabled}
                  onChange={(e) => setNotifyDone(e.target.checked)}
                />
              </label>
              <label className="settings-row settings-subrow">
                <span>{t("settings.notifyError")}</span>
                <input
                  type="checkbox"
                  checked={notifyError}
                  disabled={!notificationsEnabled}
                  onChange={(e) => setNotifyError(e.target.checked)}
                />
              </label>
              <label className="settings-row settings-subrow">
                <span>{t("settings.notifyHiddenPanes")}</span>
                <input
                  type="checkbox"
                  checked={notifyHiddenPanes}
                  disabled={!notificationsEnabled}
                  onChange={(e) => setNotifyHiddenPanes(e.target.checked)}
                />
              </label>

              <label className="settings-row">
                <span>{t("settings.defaultShell")}</span>
                <input
                  type="text"
                  value={defaultShell}
                  placeholder={t("settings.defaultShellPlaceholder")}
                  onChange={(e) => setDefaultShell(e.target.value)}
                />
              </label>

              <label className="settings-row">
                <span>{t("settings.defaultCwd")}</span>
                <input
                  type="text"
                  value={defaultCwd}
                  placeholder={t("settings.defaultCwdPlaceholder")}
                  onChange={(e) => setDefaultCwd(e.target.value)}
                />
              </label>
            </>
          )}

          {tab === "appearance" && (
            <>
              <label className="settings-row">
                <span>{t("settings.theme")}</span>
                <select value={themeName} onChange={(e) => setThemeName(e.target.value)}>
                  {THEME_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {THEME_LABEL_KEYS[name] ? t(THEME_LABEL_KEYS[name]) : THEME_LABELS[name]}
                    </option>
                  ))}
                  {customThemes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="settings-row settings-row-actions">
                <button className="settings-secondary" onClick={createCustomFromCurrent}>
                  {t("settings.themeCustomCreate")}
                </button>
              </div>

              {customTheme && (
                <>
                  <div className="settings-row">
                    <span>{t("settings.themeCustomName")}</span>
                    <input
                      type="text"
                      value={customTheme.name}
                      onChange={(e) =>
                        updateCustomTheme(customTheme.id, { name: e.target.value })
                      }
                    />
                    <button
                      className="settings-theme-delete"
                      onClick={() => deleteCustomTheme(customTheme.id)}
                    >
                      {t("settings.themeCustomDelete")}
                    </button>
                  </div>

                  <div className="settings-section">{t("settings.themeUiColors")}</div>
                  <div className="settings-color-grid">
                    {UI_COLOR_FIELDS.map(({ key, labelKey }) => (
                      <label key={key}>
                        <input
                          type="color"
                          value={customTheme.ui[key] ?? "#000000"}
                          onChange={(e) =>
                            updateCustomTheme(customTheme.id, {
                              ui: { ...customTheme.ui, [key]: e.target.value },
                            })
                          }
                        />
                        <span>{t(labelKey)}</span>
                      </label>
                    ))}
                  </div>

                  <div className="settings-section">{t("settings.themeTerminalColors")}</div>
                  <div className="settings-color-grid">
                    {TERMINAL_COLOR_FIELDS.map(({ key, labelKey }) => (
                      <label key={key}>
                        <input
                          type="color"
                          value={customTheme.terminal[key] ?? "#000000"}
                          onChange={(e) =>
                            updateCustomTheme(customTheme.id, {
                              terminal: { ...customTheme.terminal, [key]: e.target.value },
                            })
                          }
                        />
                        <span>{t(labelKey)}</span>
                      </label>
                    ))}
                  </div>

                  <div className="settings-section">{t("settings.themeAnsiColors")}</div>
                  <div className="settings-color-grid">
                    {ANSI_COLOR_FIELDS.map(({ key, label }) => (
                      <label key={key}>
                        <input
                          type="color"
                          value={customTheme.terminal[key] ?? "#000000"}
                          onChange={(e) =>
                            updateCustomTheme(customTheme.id, {
                              terminal: { ...customTheme.terminal, [key]: e.target.value },
                            })
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              <label className="settings-row">
                <span>{t("settings.fontFamily")}</span>
                <select
                  value={selectedFontPresetId}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM_FONT_FAMILY_ID) {
                      setForceCustomFont(true);
                      return;
                    }
                    setForceCustomFont(false);
                    const preset = fontOptions.find((p) => p.id === e.target.value);
                    if (preset) setFontFamily(preset.value);
                  }}
                >
                  {fontOptions.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                  <option value={CUSTOM_FONT_FAMILY_ID}>{t("settings.fontFamilyCustom")}</option>
                </select>
              </label>

              {selectedFontPresetId === CUSTOM_FONT_FAMILY_ID && (
                <label className="settings-row">
                  <span>{t("settings.fontFamilyCustomValue")}</span>
                  <input
                    type="text"
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                  />
                </label>
              )}

              <label className="settings-row">
                <span>{t("settings.fontSize")}</span>
                <input
                  type="number"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  value={fontSize}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    // setFontSize 會夾在 FONT_SIZE_MIN/MAX 內；輸入中的空字串（NaN）略過。
                    if (v > 0) setFontSize(v);
                  }}
                />
              </label>

              <label className="settings-row">
                <span>{t("settings.cursorStyle")}</span>
                <select
                  value={cursorStyle}
                  onChange={(e) => setCursorStyle(e.target.value as CursorStyle)}
                >
                  {CURSOR_STYLES.map((c) => (
                    <option key={c} value={c}>
                      {t(CURSOR_STYLE_KEYS[c])}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row">
                <span>{t("settings.cursorBlink")}</span>
                <input
                  type="checkbox"
                  checked={cursorBlink}
                  onChange={(e) => setCursorBlink(e.target.checked)}
                />
              </label>

              <div className="settings-row">
                <span>{t("settings.backgroundImage")}</span>
                <span className="settings-bg-controls">
                  <button
                    className="settings-secondary"
                    onClick={async () => {
                      const path = await pickImage();
                      if (path) setBackgroundImage(path);
                    }}
                  >
                    {t("settings.backgroundImageChoose")}
                  </button>
                  {backgroundImage && (
                    <button
                      className="settings-theme-delete"
                      onClick={() => setBackgroundImage("")}
                    >
                      {t("settings.backgroundImageClear")}
                    </button>
                  )}
                </span>
              </div>
              {backgroundImage && (
                <>
                  <div className="settings-row">
                    <span className="settings-bg-filename">
                      {backgroundImage.split(/[\\/]/).pop()}
                    </span>
                  </div>
                  <label className="settings-row">
                    <span>{t("settings.backgroundDim")}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={backgroundDim}
                      onChange={(e) => setBackgroundDim(Number(e.target.value))}
                    />
                  </label>
                </>
              )}
            </>
          )}

          {tab === "integrations" && <IntegrationSection />}

          {tab === "about" && (
            <>
              <div className="settings-row">
                <span>{t("settings.updateVersion")}</span>
                <span>{appVersion}</span>
              </div>

              <div className="settings-row">
                <span>{t("settings.updateStatus")}</span>
                {updatePhase === "available" ? (
                  <span className="settings-update">
                    {t("update.available", { version: updateVersion ?? "" })}
                    <button
                      className="settings-update-install"
                      onClick={() => void installPendingUpdate()}
                    >
                      {t("update.installNow")}
                    </button>
                  </span>
                ) : (
                  <span>
                    {updatePhase === "idle" || updatePhase === "checking"
                      ? t("update.checking")
                      : t(`update.${updatePhase}`, { version: updateVersion ?? "" })}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
