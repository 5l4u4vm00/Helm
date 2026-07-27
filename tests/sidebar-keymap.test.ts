// 執行：node --experimental-strip-types tests/sidebar-keymap.test.ts
import assert from "node:assert";
import {
  resolveSidebarShortcut,
  SIDEBAR_TABLE,
  type SidebarKeyLike,
  type SidebarTarget,
} from "../src/components/SessionSidebar/sidebarKeymap.ts";

let passed = 0;
function check(name: string, actual: string | null, expected: string | null) {
  assert.strictEqual(actual, expected, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

const res = (target: SidebarTarget, e: SidebarKeyLike | string) =>
  resolveSidebarShortcut(target, typeof e === "string" ? { key: e } : e);

check("session Enter activates", res("session", "Enter"), "activate-session");
check("workspace Space toggles", res("workspace", " "), "toggle-workspace");
check("session h returns to parent", res("session", "h"), "focus-parent");
check("workspace left collapses", res("workspace", "ArrowLeft"), "collapse-workspace");
check("workspace right expands or enters", res("workspace", "l"), "expand-or-enter-workspace");
check("session l is unmapped", res("session", "l"), null);
check("r renames either target", res("workspace", "r"), "rename");
check("F2 renames", res("session", "F2"), "rename");
check("Escape returns to terminal", res("workspace", "Escape"), "focus-terminal");
check("f chooses current workspace folder", res("session", "f"), "choose-folder");
check("unmapped key is ignored", res("workspace", "q"), null);

// Letters aligned with the global layer: c/w/x mirror Ctrl+A c / w / x.
check("c creates a session here", res("session", "c"), "new-session");
check("w creates a workspace", res("workspace", "w"), "new-workspace");
check("x requests destructive action", res("session", "x"), "request-delete");
check("Delete requests destructive action", res("session", "Delete"), "request-delete");
check("Backspace requests destructive action", res("session", "Backspace"), "request-delete");
// The pre-realignment letters must be inert, not silently aliased.
check("legacy a is no longer new-session", res("session", "a"), null);
check("legacy A is no longer new-workspace", res("workspace", "A"), null);

// Bare keys only: the global layer and the OS own the modified variants.
check("Ctrl+r does not rename", res("session", { key: "r", ctrlKey: true }), null);
check("Alt+f does not choose folder", res("session", { key: "f", altKey: true }), null);
check("Cmd+x does not delete", res("session", { key: "x", metaKey: true }), null);
check("Ctrl+Enter does not activate", res("session", { key: "Enter", ctrlKey: true }), null);
// Shift must stay allowed — some keys carry it in the character itself.
check("Shift is allowed through", res("workspace", { key: "r", shiftKey: true } as SidebarKeyLike), "rename");

// Table sanity: no key is claimed twice for the same target.
for (const target of ["session", "workspace"] as SidebarTarget[]) {
  const seen = new Set<string>();
  for (const b of SIDEBAR_TABLE) {
    if (b.targets && !b.targets.includes(target)) continue;
    for (const k of b.keys) {
      assert.ok(!seen.has(k), `FAIL: key ${JSON.stringify(k)} bound twice for ${target}`);
      seen.add(k);
    }
  }
}
passed++;
console.log("  ok - no key is bound twice for the same target");

console.log(`sidebar-keymap: ${passed} checks passed`);
