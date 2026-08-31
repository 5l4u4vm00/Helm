"""Pane sizing / restore-replay geometry.

This is the `waitForWidth` regression class. `replay.ts` was correct and fully
unit-tested (it stores *logical* lines precisely so a new width may refold
them), yet the restored pane came back squeezed: the fit guard in Terminal.tsx
checked `clientWidth` but not `clientHeight`, so during the cold-start window
where the pane has width but not yet height, `fit()` computed a minimum grid and
the replay's hard CRLF line breaks were burned into the buffer permanently.

The invariant these checks defend is the one a pure test cannot express: **the
grid xterm actually renders must match the pane it actually occupies** -- at
boot, after switching sessions, at a narrow viewport, and after a resize. A pane
that initialised while hidden (display:none => 0x0) is the restore case, and the
one that regressed.

`npm run dev` gives no PTY, so the terminal stays blank. That is fine: cols/rows
come from FitAddon measuring the DOM, which is exactly the half that broke.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import Results, boot, dev_server, fresh_page  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

# Title is "在此 Workspace 新增 <launcher>" and tracks the default
# launcher name, so match the stable prefix rather than the whole string.
ADD_SESSION_BTN = "button[title^='在此 Workspace 新增']"

# A correctly fitted pane leaves at most one partial cell plus padding unused.
# The squeeze bug produced a grid clamped to a minimum (roughly 9x5 cells), i.e.
# a screen box a small fraction of its host -- far outside these ratios.
MIN_FILL_W = 0.75
MIN_FILL_H = 0.70
# Enough rows that a 9x5-style clamp cannot pass. At the smallest viewport this
# suite uses (460px tall) a real fit still yields well over 20 rows.
MIN_SANE_SCREEN_H = 120

# Reads the live grid straight off xterm's own DOM.
# `.xterm-screen` is the box the renderer committed to --
# not what React thinks it asked for.
GRID_JS = """
() => {
  const out = [];
  for (const pane of document.querySelectorAll('.pane')) {
    const host = pane.querySelector('.terminal-host');
    const screen = pane.querySelector('.xterm-screen');
    if (!host || !screen) continue;
    // The renderer is CanvasAddon (see renderer.ts), so there is no
    // `.xterm-rows` DOM row list to count -- the grid is painted into canvas
    // layers. `.xterm-screen` is the box xterm committed to for the current
    // cols/rows, and the text layer canvas is sized from the same dimensions,
    // so those two are the authoritative geometry here.
    const text = pane.querySelector('canvas.xterm-text-layer');
    out.push({
      inLayout: pane.getAttribute('data-in-layout'),
      active: pane.getAttribute('data-active'),
      hostW: host.clientWidth,
      hostH: host.clientHeight,
      screenW: screen.clientWidth,
      screenH: screen.clientHeight,
      layerW: text ? text.clientWidth : 0,
      layerH: text ? text.clientHeight : 0,
    });
  }
  return out;
}
"""


def grids(page):
    return page.evaluate(GRID_JS)


def visible(gs):
    return [g for g in gs if g["inLayout"] == "true"]


def add_session(page):
    page.locator(ADD_SESSION_BTN).first.click()
    page.wait_for_timeout(150)
    menu = page.locator(".launcher-menu button[role='menuitem']")
    if menu.count() > 0:
        menu.first.click()
    page.wait_for_timeout(500)


def main():
    r = Results()
    with dev_server():
        with sync_playwright() as p:
            b = p.chromium.launch()

            # --- boot: the solo pane fills its box -------------------------
            ctx, page = fresh_page(b, width=1400, height=900)
            boot(page)
            gs = visible(grids(page))
            if not r.check("one visible pane at boot", len(gs) == 1, "got %d" % len(gs)):
                ctx.close()
                b.close()
                return r.report("pane-sizing")
            g = gs[0]
            r.check("pane host has real width", g["hostW"] > 200, "hostW=%d" % g["hostW"])
            r.check("pane host has real height", g["hostH"] > 200, "hostH=%d" % g["hostH"])
            r.check(
                "grid is not collapsed to a minimum",
                g["screenH"] >= MIN_SANE_SCREEN_H,
                "screenH=%d" % g["screenH"],
            )
            r.check(
                "canvas text layer matches the screen box (renderer agrees on size)",
                g["layerW"] == g["screenW"] and g["layerH"] == g["screenH"],
                "layer=%dx%d screen=%dx%d"
                % (g["layerW"], g["layerH"], g["screenW"], g["screenH"]),
            )
            # The squeeze symptom: grid far narrower than the box it sits in.
            r.check(
                "xterm screen fills most of the host width (not squeezed left)",
                g["screenW"] >= g["hostW"] * MIN_FILL_W,
                "screenW=%d vs hostW=%d" % (g["screenW"], g["hostW"]),
            )
            r.check(
                "xterm screen fills most of the host height (cursor not pinned to top)",
                g["screenH"] >= g["hostH"] * MIN_FILL_H,
                "screenH=%d vs hostH=%d" % (g["screenH"], g["hostH"]),
            )
            ctx.close()

            # --- a pane that initialises while hidden ----------------------
            # The restore case that regressed: the pane is created while not in
            # layout (display:none => 0x0), so it must not bake a minimum grid;
            # it has to fit correctly once shown.
            ctx, page = fresh_page(b, width=1400, height=900)
            boot(page)
            add_session(page)
            allg = grids(page)
            hidden = [x for x in allg if x["inLayout"] == "false"]
            r.check(
                "second session leaves an out-of-layout pane",
                len(hidden) >= 1,
                "panes=%r" % (allg,),
            )

            page.locator(".session-item").nth(0).click()
            page.wait_for_timeout(700)
            gs = visible(grids(page))
            r.check(
                "switching back leaves exactly one visible pane",
                len(gs) == 1,
                "got %d" % len(gs),
            )
            if gs:
                g = gs[0]
                r.check(
                    "a pane shown after initialising hidden is not squeezed",
                    g["screenW"] >= g["hostW"] * MIN_FILL_W,
                    "screenW=%d vs hostW=%d" % (g["screenW"], g["hostW"]),
                )
                r.check(
                    "that pane's grid is not collapsed vertically",
                    g["screenH"] >= g["hostH"] * MIN_FILL_H,
                    "screenH=%d vs hostH=%d" % (g["screenH"], g["hostH"]),
                )
            ctx.close()

            # --- a narrow viewport must still not collapse the grid --------
            ctx, page = fresh_page(b, width=620, height=460)
            boot(page)
            gs = visible(grids(page))
            if r.check("narrow viewport still renders a pane", len(gs) == 1, "got %d" % len(gs)):
                g = gs[0]
                r.check(
                    "narrow viewport: grid still fills its host width",
                    g["screenW"] >= g["hostW"] * MIN_FILL_H,
                    "screenW=%d vs hostW=%d" % (g["screenW"], g["hostW"]),
                )
                r.check(
                    "narrow viewport: grid keeps a sane height",
                    g["screenH"] >= g["hostH"] * MIN_FILL_H,
                    "screenH=%d vs hostH=%d" % (g["screenH"], g["hostH"]),
                )
            ctx.close()

            # --- resize refits ---------------------------------------------
            ctx, page = fresh_page(b, width=900, height=700)
            boot(page)
            before = visible(grids(page))[0]
            page.set_viewport_size({"width": 1500, "height": 950})
            # FIT_SETTLE_MS plus the rAF coalesce; give the trailing fit room.
            page.wait_for_timeout(1400)
            after = visible(grids(page))[0]
            r.check(
                "growing the window grows the rendered grid",
                after["screenH"] > before["screenH"] or after["screenW"] > before["screenW"],
                "before=%r after=%r" % (before, after),
            )
            r.check(
                "after resize the grid still fills the host",
                after["screenW"] >= after["hostW"] * MIN_FILL_W,
                "screenW=%d vs hostW=%d" % (after["screenW"], after["hostW"]),
            )
            ctx.close()
            b.close()
    return r.report("pane-sizing")


if __name__ == "__main__":
    raise SystemExit(main())
