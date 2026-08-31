# Interaction tests

```bash
npm run test:e2e          # all suites, one dev server
python tests/e2e/test_sidebar_drag.py    # one suite
```

Requires:

```bash
pip install -r tests/e2e/requirements.txt
python -m playwright install chromium
```

The runner starts `npm run dev` itself and tears it down on exit, or reuses a
server already answering on :1420 — so an interactive `npm run dev` stays usable
while iterating.

**In CI:** the `frontend` job runs these on `ubuntu-latest` after `npm test`
(see `.github/workflows/ci.yml`). Linux only, deliberately — these suites assert
on DOM geometry and store wiring, not platform behaviour, and neither
platform-specific failure they were written for is reproducible in headless
Chromium on any runner. Playwright is pinned in `requirements.txt` because a
bump also changes the bundled Chromium, and these checks measure real layout.

## Why this layer exists

`tests/*.test.ts` covers the pure layer thoroughly (760+ checks) and is the right
place for anything expressible as a function. It cannot, by construction, catch a
**correct decision wired to the DOM incorrectly** — and Helm has shipped that bug
twice:

| Version | Pure logic | What shipped |
|---|---|---|
| v0.20.1 | `sidebarOrder.ts` correct, fully tested | Sidebar drag completely dead on Windows — WebView2's native `IDropTarget` swallowed HTML5 DnD |
| the `waitForWidth` fix | `replay.ts` correct, fully tested | Restored pane squeezed into a narrow column — the fit guard checked width but not height |

Both were invisible to every unit test and only surfaced in real use. These
suites drive the actual components in a real browser so that class of failure has
somewhere to be caught.

## Scope, and what this cannot do

Browser mode (`npm run dev`, vite only) renders the full UI; Tauri IPC rejects
silently, so terminals stay blank. That is fine for everything here — sidebar
gestures and pane geometry are DOM/React/store, not PTY bytes. Rust changes,
PTY streaming and native menus still need `npm run tauri dev` by hand.

Two honest limitations, both established by experiment rather than assumed:

- **Chromium is not WebView2.** Removing `setPointerCapture` — the exact omission
  that shipped broken — does *not* fail `test_sidebar_drag`, because Chromium has
  no native `IDropTarget` to lose the pointer to. The suite pins the contract
  that replaced HTML5 DnD (pointer transport, `touch-action: none`, threshold,
  swallowed click) so a refactor cannot quietly regress to a transport with the
  same flaw, but the platform bug itself is only reproducible on Windows +
  WebView2.
- **The squeeze bug's *damage* needs a scrollback file.** With the fix reverted,
  `test_pane_sizing` still passes: Chromium settles width and height in the same
  frame, and even when the 0-height window is forced open, the `ResizeObserver`
  recovers the grid, so the end state is identical. What the bug permanently
  destroys is *replay content* baked at the clamped width, and seeding a
  scrollback file needs Tauri. That guard is therefore pinned where it is
  observable — `tests/fit-guard.test.ts` against the pure `canFit`, which does
  fail on the width-only version. These checks cover the surrounding geometry
  invariant (the rendered grid matches the pane it occupies).

The second point is the general rule: when a wiring bug turns out to have a pure
core, extract the core and unit-test it. `canFit` exists because three call sites
in `Terminal.tsx` disagreed about what "has a size" meant, and the one that
disagreed was the bug.

## Adding a suite

Copy an existing module's shape: import `Results`/`boot`/`dev_server`/`fresh_page`
from `harness.py`, return `r.report(name)`, and add the module to `SUITES` in
`run_all.py`. Prefer asserting an invariant a user could describe ("the grid
fills the pane", "the row moved") over internal state.

Gotchas that cost time here, so they are worth knowing:

- **`.session-item.active`** marks the active row. `data-active` is the *pane's*
  attribute, not the row's.
- The add-session button title is `在此 Workspace 新增 <launcher>` and tracks
  the default launcher name, so match on the prefix.
- The renderer is `CanvasAddon`, so there is **no `.xterm-rows`** DOM row list to
  count — read `.xterm-screen` and the canvas layers instead.
- vite may bind IPv6 (`::1`) only — it does on Windows — so a socket probe on
  127.0.0.1 reports the port closed while the server is serving. Worse, the two
  halves disagree about `localhost`: Python's urllib follows it to `::1`, but
  Chromium tries IPv4 first and fails with `ERR_CONNECTION_REFUSED`. `harness.py`
  therefore probes candidate hosts over HTTP and pins `URL` to the literal host
  that answered, so probe and browser hit the same socket. Call `boot(page)`
  without a `url` — a default argument would capture the pre-probe value.
- `helm.workspaces` persists in localStorage; always use `fresh_page()`.
- A drag must clear `DRAG_THRESHOLD_PX` (5) on its *first* move, and move in
  several steps — the controller hit-tests groups live on every move.
