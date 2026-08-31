// Sidebar drag auto-scroll ramp tests (no GUI / Tauri needed).
// Run: node --experimental-strip-types tests/sidebar-autoscroll.test.ts
import assert from "node:assert";
import {
  autoScrollStep,
  AUTOSCROLL_MAX_PX,
  AUTOSCROLL_ZONE_PX,
} from "../src/components/SessionSidebar/autoScroll.ts";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// A tall list: the two edge zones are nowhere near each other.
const list = { top: 100, bottom: 500 };

// --- the quiet middle ------------------------------------------------------
check("正中間不捲動", autoScrollStep(300, list) === 0);
check("剛好離開上緣感應區不捲動", autoScrollStep(100 + AUTOSCROLL_ZONE_PX, list) === 0);
check("剛好離開下緣感應區不捲動", autoScrollStep(500 - AUTOSCROLL_ZONE_PX, list) === 0);

// --- direction -------------------------------------------------------------
check("靠近上緣往上捲（負值）", autoScrollStep(105, list) < 0);
check("靠近下緣往下捲（正值）", autoScrollStep(495, list) > 0);

// --- the ramp --------------------------------------------------------------
// Entering the zone is a nudge; the very edge is fast. Without the ramp the
// list would jump at full speed the moment the pointer grazed the zone.
check("越接近上緣越快", autoScrollStep(102, list) < autoScrollStep(120, list));
check("越接近下緣越快", autoScrollStep(498, list) > autoScrollStep(480, list));
check("剛好在上緣是最大速度", autoScrollStep(100, list) === -AUTOSCROLL_MAX_PX);
check("剛好在下緣是最大速度", autoScrollStep(500, list) === AUTOSCROLL_MAX_PX);

// Dragging past the edge must stay pinned at full speed, not wrap back through
// zero -- that is what the Math.max(…, 0) clamp is for.
check("拖出上緣之外維持最大速度", autoScrollStep(20, list) === -AUTOSCROLL_MAX_PX);
check("拖出下緣之外維持最大速度", autoScrollStep(900, list) === AUTOSCROLL_MAX_PX);

// --- degenerate lists ------------------------------------------------------
// A list shorter than two zones has them overlap. Top must win outright, or the
// midpoint scrolls up and down on alternating frames and the list judders.
const shortList = { top: 100, bottom: 120 };
check("極短清單的中點只往一個方向捲", autoScrollStep(110, shortList) < 0);
check("零高度的 rect 不會爆掉", Number.isFinite(autoScrollStep(100, { top: 100, bottom: 100 })));

// --- speed is bounded ------------------------------------------------------
// The loop runs every frame, so an unbounded step would fly past the target.
for (const y of [0, 100, 110, 300, 490, 500, 10_000]) {
  check(
    `y=${y} 的速度不超過上限`,
    Math.abs(autoScrollStep(y, list)) <= AUTOSCROLL_MAX_PX,
  );
}

console.log(`\nsidebar-autoscroll: ${passed} checks passed`);
