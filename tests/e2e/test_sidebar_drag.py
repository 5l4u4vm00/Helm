"""Sidebar drag/reorder, driven as real pointer gestures.

This is the v0.20.1 regression class. `sidebarOrder.ts` was correct and fully
unit-tested, yet the feature was dead on Windows: the transport (HTML5 DnD) was
swallowed by WebView2's native IDropTarget. Nothing below asserts the pure
algebra -- `tests/sidebar-order.test.ts` already owns that. What is asserted here
is that a *pointer gesture on the actual rows* moves the actual list, plus the
DOM preconditions the fix identified as load-bearing:

  * `touch-action: none` on the draggable rows -- without it WebView2 reads a
    vertical drag over the scrolling list as a scroll and fires pointercancel.
  * a press only becomes a drag past DRAG_THRESHOLD_PX, so an ordinary click
    still selects the row.
  * the click that ends a real drag is swallowed, so a row you only moved does
    not also get activated.

Chromium-on-Windows is not WebView2, so this cannot reproduce the IDropTarget
bug itself. It does lock in the contract that replaced it, which is what stops a
future refactor from quietly reverting to a transport with the same flaw.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import Results, boot, dev_server, fresh_page, sidebar_order  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

# Must stay > DRAG_THRESHOLD_PX (5) in dragContext.tsx, or the press never
# becomes a drag and every assertion below would pass for the wrong reason.
STEP = 14

# The sidebar marks the active row with a class (`.session-item.active`);
# `data-active` is the *pane's* attribute, not the row's.
ACTIVE_ID_JS = """
() => {
  const el = document.querySelector('.session-item.active');
  return el ? el.getAttribute('data-session-id') : null;
}
"""


def add_sessions(page, count):
    """Add sessions to the first workspace via its + button (opens a launcher menu)."""
    for _ in range(count):
        # Title is "新增 <launcher>" and tracks the default launcher name
        # ("Shell"), so match on the stable prefix rather than the whole string.
        page.locator("button[title^='在此 Workspace 新增']").first.click()
        page.wait_for_timeout(120)
        menu = page.locator(".launcher-menu button[role='menuitem']")
        if menu.count() > 0:
            menu.first.click()
            page.wait_for_timeout(220)


def drag_row(page, from_idx, to_idx, settle=320):
    """Press row `from_idx`, cross the threshold, move onto row `to_idx`, release.

    Moves in several steps: the controller hit-tests groups live on every move
    and only arms the drag past the threshold, so a single jump would skip the
    arming move entirely.
    """
    rows = page.locator(".session-item")
    src = rows.nth(from_idx).bounding_box()
    dst = rows.nth(to_idx).bounding_box()
    assert src and dst, "rows must be laid out"

    sx = src["x"] + src["width"] / 2
    sy = src["y"] + src["height"] / 2
    # Aim past the target's midpoint in the direction of travel so pointerHalf()
    # resolves to the far side -- the insertion index a user would read off the
    # indicator.
    going_down = to_idx > from_idx
    ty = dst["y"] + (dst["height"] * 0.75 if going_down else dst["height"] * 0.25)
    tx = dst["x"] + dst["width"] / 2

    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx, sy + (STEP if going_down else -STEP))
    page.wait_for_timeout(60)
    for i in range(1, 5):
        page.mouse.move(sx + (tx - sx) * i / 4, sy + (ty - sy) * i / 4)
        page.wait_for_timeout(40)
    page.mouse.move(tx, ty)
    page.wait_for_timeout(80)
    page.mouse.up()
    page.wait_for_timeout(settle)


def main():
    r = Results()
    with dev_server():
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx, page = fresh_page(b)
            boot(page)

            # --- DOM preconditions the Windows fix depends on ---------------
            ta = page.eval_on_selector(".session-item", "e => getComputedStyle(e).touchAction")
            r.eq("session rows set touch-action:none (else WebView2 pointercancel)", ta, "none")

            wh = page.eval_on_selector(".workspace-header", "e => getComputedStyle(e).touchAction")
            r.eq("workspace headers set touch-action:none", wh, "none")

            add_sessions(page, 3)
            order = sidebar_order(page)
            if not r.check("4 sessions present to reorder", len(order) == 4, "got %d" % len(order)):
                return r.report("sidebar-drag")

            # --- a press below the threshold is a click, never a move -------
            before = sidebar_order(page)
            box = page.locator(".session-item").nth(0).bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.down()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2 + 3)
            page.mouse.up()
            page.wait_for_timeout(280)
            r.eq("a 3px press (< threshold) does not reorder", sidebar_order(page), before)
            r.eq(
                "that press still activated the row (ordinary click not swallowed)",
                page.evaluate(ACTIVE_ID_JS),
                before[0],
            )

            # --- drag down -------------------------------------------------
            before = sidebar_order(page)
            moved = before[0]
            drag_row(page, 0, 2)
            after = sidebar_order(page)
            r.check(
                "dragging row 0 down past row 2 moves it (pointer transport works)",
                after != before,
                "order unchanged: %r" % (after,),
            )
            r.check(
                "dragged session is no longer first",
                after.index(moved) > 0,
                "index %d in %r" % (after.index(moved), after),
            )
            r.eq("no session lost or duplicated", sorted(after), sorted(before))

            # --- drag back up ----------------------------------------------
            idx = sidebar_order(page).index(moved)
            drag_row(page, idx, 0)
            back = sidebar_order(page)
            r.eq("dragging it back to the top restores first position", back[0], moved)
            r.eq("still no session lost or duplicated", sorted(back), sorted(before))

            # --- the click that ends a real drag is swallowed ---------------
            # pointerup precedes click, so React state cannot gate it; without
            # the capture-phase swallow a row you only moved would also activate.
            page.locator(".session-item").nth(3).click()
            page.wait_for_timeout(280)
            active_before = page.evaluate(ACTIVE_ID_JS)
            r.eq(
                "sanity: a plain click activates the clicked row",
                active_before,
                sidebar_order(page)[3],
            )
            drag_row(page, 0, 2)
            r.eq(
                "a completed drag leaves the active session unchanged (click swallowed)",
                page.evaluate(ACTIVE_ID_JS),
                active_before,
            )

            ctx.close()
            b.close()
    return r.report("sidebar-drag")


if __name__ == "__main__":
    raise SystemExit(main())
