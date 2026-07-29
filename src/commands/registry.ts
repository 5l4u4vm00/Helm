// Central command registry: the single dispatch point for global hotkeys,
// the command palette, and the native menu (app://shortcut events).
// To add a keyboard-reachable action: add a Command here and, if it needs a
// hotkey, a PrefixBinding in prefix.ts (Ctrl+A sequences; plus a menu item
// in lib.rs when useful). Direct bindings in keymap.ts are reserved for the
// few shortcuts that must work without the prefix (currently only ⌘⇧P).
import { useSessionStore } from "../store/sessions";
import { groupTreeOf, useLayoutStore } from "../store/layout";
import { useUiStore } from "../store/ui";
import { useThemeStore } from "../store/theme";
import { collectSessionIds } from "../store/layoutTree";
import {
  pendingApprovalsInWorkspace,
  resolveFocusedWorkspace,
} from "../store/workspaceGroups";
import { listLaunchers } from "../agents/registry";
import { cycleFocusRegion, focusActiveTerminal } from "../focus/focusUtils";
import { useLanguageStore } from "../store/language";
import { t } from "../i18n";
import {
  activateSession,
  cycleSession,
  focusPane,
  focusSidebar,
  newSession,
  newWorkspace,
  renameActiveSession,
  resizeActivePane,
  respondActiveApproval,
  respondAllApprovals,
  sendPrefixLiteral,
  splitActivePane,
  switchToSessionIndex,
} from "./actions";
import type { Command } from "./types";

function hasActive(): boolean {
  return useSessionStore.getState().activeId !== null;
}

function activeHasApproval(): boolean {
  const { sessions, activeId } = useSessionStore.getState();
  return Boolean(sessions.find((s) => s.id === activeId)?.pendingApproval);
}

// Scoped to the focused workspace, matching respondAllApprovals' semantics.
function anyApproval(): boolean {
  const { sessions, activeId } = useSessionStore.getState();
  const workspaceId = resolveFocusedWorkspace(sessions, activeId);
  return pendingApprovalsInWorkspace(sessions, workspaceId).length > 0;
}

/** Leaves in the active session's split group (0 when ungrouped). */
function activeGroupLeafCount(): number {
  const { activeId } = useSessionStore.getState();
  return collectSessionIds(groupTreeOf(useLayoutStore.getState().trees, activeId))
    .length;
}

function activeIsGrouped(): boolean {
  return activeGroupLeafCount() >= 2;
}

const PANE_DIRS = [
  ["left", "command.dirLeft"],
  ["right", "command.dirRight"],
  ["up", "command.dirUp"],
  ["down", "command.dirDown"],
] as const;

const RESIZE_TITLE_KEYS = {
  left: "command.resizeLeft",
  right: "command.resizeRight",
  up: "command.resizeUp",
  down: "command.resizeDown",
} as const;

function layoutCommands(): Command[] {
  const nav: Command[] = PANE_DIRS.map(([dir, dirKey]) => ({
    id: `layout:focus-${dir}`,
    title: t("command.focusPane", { dir: t(dirKey) }),
    category: t("category.layout"),
    keywords: "focus pane",
    // Left stays enabled when ungrouped: at the left edge it overflows
    // into the sidebar (see focusPane).
    enabled: dir === "left" ? hasActive : activeIsGrouped,
    run: () => focusPane(dir),
  }));
  const resize: Command[] = PANE_DIRS.map(([dir]) => ({
    id: `layout:resize-${dir}`,
    title: t(RESIZE_TITLE_KEYS[dir]),
    category: t("category.layout"),
    keywords: "resize pane",
    enabled: activeIsGrouped,
    run: () => resizeActivePane(dir),
  }));
  return [...nav, ...resize];
}

function numberedSwitchCommands(): Command[] {
  return Array.from({ length: 9 }, (_, i) => ({
    id: `session:switch-${i + 1}`,
    title: t("command.switchToIndex", { n: i + 1 }),
    category: t("category.session"),
    hidden: true,
    enabled: () => useSessionStore.getState().sessions.length > i,
    run: () => switchToSessionIndex(i),
  }));
}

function staticCommands(): Command[] {
  return [
    {
      id: "palette:open",
      title: t("command.paletteOpen"),
      category: t("category.view"),
      keywords: "command palette",
      run: () => {
        const ui = useUiStore.getState();
        ui.setPaletteOpen(!ui.paletteOpen);
      },
    },
    {
      id: "layout:split-right",
      title: t("command.splitRight"),
      category: t("category.layout"),
      keywords: "split right",
      enabled: hasActive,
      run: () => splitActivePane("row"),
    },
    {
      id: "layout:split-down",
      title: t("command.splitDown"),
      category: t("category.layout"),
      keywords: "split down",
      enabled: hasActive,
      run: () => splitActivePane("column"),
    },
    {
      id: "layout:close-pane",
      title: t("command.closePane"),
      category: t("category.layout"),
      keywords: "close pane",
      enabled: hasActive,
      run: () => {
        const store = useSessionStore.getState();
        if (store.activeId) store.closeSession(store.activeId);
      },
    },
    {
      id: "layout:focus-next-pane",
      title: t("command.focusNextPane"),
      category: t("category.layout"),
      keywords: "next pane",
      enabled: activeIsGrouped,
      run: () => focusPane("next"),
    },
    ...layoutCommands(),
    {
      id: "session:new",
      title: t("command.newSession"),
      category: t("category.session"),
      keywords: "new session shell",
      run: () => newSession(),
    },
    {
      id: "session:next",
      title: t("command.nextSession"),
      category: t("category.session"),
      keywords: "next session",
      enabled: () => useSessionStore.getState().sessions.length >= 2,
      run: () => cycleSession(1),
    },
    {
      id: "session:prev",
      title: t("command.prevSession"),
      category: t("category.session"),
      keywords: "previous session",
      enabled: () => useSessionStore.getState().sessions.length >= 2,
      run: () => cycleSession(-1),
    },
    {
      id: "session:rename-active",
      title: t("command.renameSession"),
      category: t("category.session"),
      keywords: "rename session title name",
      enabled: hasActive,
      run: renameActiveSession,
    },
    ...numberedSwitchCommands(),
    {
      id: "workspace:new",
      title: t("command.newWorkspace"),
      category: t("category.session"),
      keywords: "new workspace group",
      run: () => {
        newWorkspace();
      },
    },
    {
      id: "view:toggle-files",
      title: t("command.toggleFiles"),
      category: t("category.view"),
      keywords: "changed files panel",
      run: () => useUiStore.getState().toggleFiles(),
    },
    {
      id: "view:toggle-notifications",
      title: t("command.toggleNotifications"),
      category: t("category.view"),
      keywords: "notifications alerts bell center",
      run: () => useUiStore.getState().toggleNotifications(),
    },
    {
      id: "view:toggle-approval",
      title: t("command.toggleApproval"),
      category: t("category.view"),
      keywords: "approval pending panel collapse hide",
      run: () => useUiStore.getState().toggleApprovalCollapsed(),
    },
    {
      id: "view:toggle-sidebar",
      title: t("command.toggleSidebar"),
      category: t("category.view"),
      keywords: "sidebar sessions hide show",
      run: () => useUiStore.getState().toggleSidebar(),
    },
    {
      id: "theme:toggle",
      title: t("command.toggleTheme"),
      category: t("category.view"),
      keywords: "toggle theme dark light",
      run: () => useThemeStore.getState().toggle(),
    },
    {
      id: "settings:open",
      title: t("command.openSettings"),
      category: t("category.view"),
      keywords: "settings preferences font theme cursor shell",
      run: () => {
        const ui = useUiStore.getState();
        ui.setSettingsOpen(!ui.settingsOpen);
      },
    },
    {
      id: "approval:approve-active",
      title: t("command.approveActive"),
      category: t("category.approval"),
      keywords: "approve",
      enabled: activeHasApproval,
      run: () => respondActiveApproval(true),
    },
    {
      id: "approval:reject-active",
      title: t("command.rejectActive"),
      category: t("category.approval"),
      keywords: "reject",
      enabled: activeHasApproval,
      run: () => respondActiveApproval(false),
    },
    {
      id: "approval:approve-all",
      title: t("command.approveAll"),
      category: t("category.approval"),
      keywords: "approve all",
      enabled: anyApproval,
      run: () => respondAllApprovals(true),
    },
    {
      id: "approval:reject-all",
      title: t("command.rejectAll"),
      category: t("category.approval"),
      keywords: "reject all",
      enabled: anyApproval,
      run: () => respondAllApprovals(false),
    },
    {
      id: "focus:cycle-region",
      title: t("command.cycleFocusRegion"),
      category: t("category.view"),
      keywords: "cycle focus region",
      run: () => cycleFocusRegion(1),
    },
    {
      id: "focus:cycle-region-back",
      title: t("command.cycleFocusRegionBack"),
      category: t("category.view"),
      keywords: "cycle focus region back",
      hidden: true,
      run: () => cycleFocusRegion(-1),
    },
    {
      id: "focus:terminal",
      title: t("command.focusTerminal"),
      category: t("category.view"),
      keywords: "focus terminal",
      enabled: hasActive,
      run: focusActiveTerminal,
    },
    {
      id: "focus:sidebar",
      title: t("command.focusSidebar"),
      category: t("category.view"),
      keywords: "focus sidebar sessions list",
      run: focusSidebar,
    },
    {
      id: "help:shortcuts",
      title: t("command.shortcutsHelp"),
      category: t("category.view"),
      keywords: "keyboard shortcuts help keys reference cheatsheet",
      run: () => {
        const ui = useUiStore.getState();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
      },
    },
    {
      // Keyboard-only escape hatch (C-a a): meaningless as a mouse action.
      id: "terminal:send-prefix",
      title: t("command.sendCtrlA"),
      category: t("category.view"),
      hidden: true,
      enabled: hasActive,
      run: sendPrefixLiteral,
    },
  ];
}

/** Palette-only commands rebuilt from live sessions / launchers. */
function dynamicCommands(): Command[] {
  const cmds: Command[] = [];
  for (const s of useSessionStore.getState().sessions) {
    cmds.push({
      id: `session:switch:${s.id}`,
      title: t("command.switchToSession", { title: s.title }),
      category: t("category.session"),
      keywords: s.agentLabel ?? "switch",
      run: () => activateSession(s.id),
    });
  }
  listLaunchers().forEach((l, i) => {
    cmds.push({
      id: `session:new:${i}`,
      title: t("command.newSessionWith", { label: l.label }),
      category: t("category.session"),
      keywords: "new session",
      run: () => newSession(l),
    });
    cmds.push({
      id: `layout:split-right-with:${i}`,
      title: t("command.splitRightWith", { label: l.label }),
      category: t("category.layout"),
      keywords: "split right",
      enabled: hasActive,
      run: () => splitActivePane("row", l),
    });
    cmds.push({
      id: `layout:split-down-with:${i}`,
      title: t("command.splitDownWith", { label: l.label }),
      category: t("category.layout"),
      keywords: "split down",
      enabled: hasActive,
      run: () => splitActivePane("column", l),
    });
  });
  return cmds;
}

// Static commands are pure closures over module functions; only their titles
// vary (with the language), so cache per language. runCommand sits on every
// hotkey/menu dispatch and must not rebuild the whole list each time.
let staticCache: { language: string; commands: Command[] } | null = null;

function cachedStaticCommands(): Command[] {
  const language = useLanguageStore.getState().name;
  if (staticCache?.language !== language) {
    staticCache = { language, commands: staticCommands() };
  }
  return staticCache.commands;
}

export function listCommands(): Command[] {
  return [...cachedStaticCommands(), ...dynamicCommands()];
}

/** Run a command by id; silently ignores unknown or disabled commands. */
export function runCommand(id: string): void {
  // 靜態表命中就不建動態清單（動態 id 只來自 palette）。
  const cmd =
    cachedStaticCommands().find((c) => c.id === id) ??
    dynamicCommands().find((c) => c.id === id);
  if (!cmd || cmd.enabled?.() === false) return;
  cmd.run();
}
