// 拖放落點 → 目標 pane 的純函式測試（不需 GUI / Tauri）。
// 執行：node --experimental-strip-types tests/drop-target.test.ts
import assert from "node:assert";
import { test } from "node:test";
import {
  paneAt,
  resolveDropTarget,
  toAreaPoint,
  type DropCandidate,
} from "../src/components/Terminal/dropTarget.ts";

const AREA = { left: 100, top: 50, width: 800, height: 400 };

// 左右對開的兩個 pane，共用 x=50 這條分隔線。
const SPLIT: DropCandidate[] = [
  { sessionId: "left", rect: { top: 0, left: 0, width: 50, height: 100 } },
  { sessionId: "right", rect: { top: 0, left: 50, width: 50, height: 100 } },
];

test("converts window coordinates into area percentages", () => {
  assert.deepStrictEqual(toAreaPoint(500, 250, AREA), { x: 50, y: 50 });
  assert.deepStrictEqual(toAreaPoint(100, 50, AREA), { x: 0, y: 0 });
  assert.deepStrictEqual(toAreaPoint(900, 450, AREA), { x: 100, y: 100 });
});

test("returns null for a drop outside the terminal area", () => {
  assert.strictEqual(toAreaPoint(50, 250, AREA), null, "left of the area (sidebar)");
  assert.strictEqual(toAreaPoint(500, 10, AREA), null, "above the area (toolbar)");
  assert.strictEqual(toAreaPoint(950, 250, AREA), null, "right of the area");
});

test("returns null for a zero-sized area instead of dividing by zero", () => {
  assert.strictEqual(toAreaPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }), null);
});

test("hits the pane containing the point", () => {
  assert.strictEqual(paneAt({ x: 25, y: 50 }, SPLIT), "left");
  assert.strictEqual(paneAt({ x: 75, y: 50 }, SPLIT), "right");
});

// 相鄰 pane 在分隔線上共用同一個座標值；半開區間讓該點只屬於一個 pane，
// 否則命中結果會取決於候選陣列的順序。
test("assigns the shared boundary to exactly one pane", () => {
  assert.strictEqual(paneAt({ x: 50, y: 50 }, SPLIT), "right");
  assert.strictEqual(paneAt({ x: 50, y: 50 }, [...SPLIT].reverse()), "right");
});

test("still hits the pane at the far right and bottom edge", () => {
  assert.strictEqual(paneAt({ x: 100, y: 100 }, SPLIT), "right");
});

test("misses when no candidate covers the point", () => {
  const partial: DropCandidate[] = [
    { sessionId: "top", rect: { top: 0, left: 0, width: 100, height: 40 } },
  ];
  assert.strictEqual(paneAt({ x: 50, y: 80 }, partial), null);
  assert.strictEqual(paneAt({ x: 50, y: 50 }, []), null);
});

test("falls back to the active session when the point is outside", () => {
  assert.strictEqual(resolveDropTarget(null, SPLIT, "active"), "active");
});

test("falls back when the point hits no pane", () => {
  assert.strictEqual(resolveDropTarget({ x: 50, y: 50 }, [], "active"), "active");
});

test("prefers the hit pane over the fallback", () => {
  assert.strictEqual(resolveDropTarget({ x: 25, y: 50 }, SPLIT, "active"), "left");
});

test("returns null when there is no pane and no active session", () => {
  assert.strictEqual(resolveDropTarget(null, [], null), null);
});
