// 執行：node --experimental-strip-types tests/sidebar-keymap.test.ts
import assert from "node:assert";
import { resolveSidebarShortcut } from "../src/components/SessionSidebar/sidebarKeymap.ts";

let passed = 0;
function check(name: string, actual: string | null, expected: string | null) {
  assert.strictEqual(actual, expected, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

check("session Enter activates", resolveSidebarShortcut("session", "Enter"), "activate-session");
check("workspace Space toggles", resolveSidebarShortcut("workspace", " "), "toggle-workspace");
check("session h returns to parent", resolveSidebarShortcut("session", "h"), "focus-parent");
check("workspace left collapses", resolveSidebarShortcut("workspace", "ArrowLeft"), "collapse-workspace");
check("workspace right expands or enters", resolveSidebarShortcut("workspace", "l"), "expand-or-enter-workspace");
check("r renames either target", resolveSidebarShortcut("workspace", "r"), "rename");
check("a creates in current workspace", resolveSidebarShortcut("session", "a"), "new-session");
check("Shift+A creates workspace", resolveSidebarShortcut("workspace", "A"), "new-workspace");
check("f chooses current workspace folder", resolveSidebarShortcut("session", "f"), "choose-folder");
check("Backspace requests destructive action", resolveSidebarShortcut("session", "Backspace"), "request-delete");
check("Escape returns to terminal", resolveSidebarShortcut("workspace", "Escape"), "focus-terminal");
check("unmapped key is ignored", resolveSidebarShortcut("workspace", "q"), null);

console.log(`sidebar-keymap: ${passed} checks passed`);
