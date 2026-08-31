"""Shared harness for Helm's browser-mode interaction tests.

Why these tests exist
---------------------
Helm's pure logic is covered by 761 node checks, but two shipped regressions
were invisible to all of them:

* v0.20.1 -- sidebar drag: `sidebarOrder.ts` was correct and fully tested, yet
  dragging did nothing on Windows because WebView2's native IDropTarget swallows
  HTML5 DnD.
* the `waitForWidth` fix -- `replay.ts` was correct and fully tested, yet the
  restored pane was squeezed because the fit guard checked width but not height.

Both are integration failures: correct decisions wired to the DOM incorrectly.
A pure-function test cannot reach them by construction, so this layer drives the
real components in a real browser.

Scope: `npm run dev` (vite only). Tauri IPC rejects silently, so terminals stay
blank -- that is fine, because every path tested here is DOM/React/store, not
PTY bytes. Rust changes still need `npm run tauri dev` by hand.
"""

from __future__ import annotations

import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

PORT = 1420
URL = f"http://localhost:{PORT}"

# vite's own port; strictPort is set in vite.config.ts so it never drifts.
SERVER_CMD = "npm run dev"


def _server_up(url: str = URL) -> bool:
    """Probe over HTTP, not a raw socket.

    vite binds `::1` only (IPv6) on this machine, so a socket probe against
    127.0.0.1 reports "closed" while the server is serving perfectly well --
    which silently made the harness start a second vite that then died on
    "Port 1420 is already in use". An HTTP GET is also the readiness signal we
    actually care about: the port can be open before vite can answer.
    """
    try:
        with urllib.request.urlopen(url, timeout=1.5) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


@contextmanager
def dev_server(timeout: float = 90.0):
    """Start `npm run dev` unless something already serves PORT.

    Reusing an already-running server keeps an interactive `npm run dev` usable
    while iterating on these tests.
    """
    if _server_up():
        print(f"[harness] reusing server already on :{PORT}")
        yield None
        return

    proc = subprocess.Popen(
        SERVER_CMD,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            if _server_up():
                print(f"[harness] dev server up on :{PORT}")
                break
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise RuntimeError(f"dev server exited early:\n{out}")
            time.sleep(0.3)
        else:
            raise RuntimeError(f"dev server did not answer {URL} within {timeout}s")
        yield proc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# --- assertions -------------------------------------------------------------

class Results:
    """Minimal check recorder; mirrors the `check(...)` style of tests/*.test.ts."""

    def __init__(self) -> None:
        self.passed = 0
        self.failures: list[str] = []

    def check(self, label: str, cond: bool, detail: str = "") -> bool:
        if cond:
            self.passed += 1
            print(f"  ok - {label}")
        else:
            msg = f"{label}{(' :: ' + detail) if detail else ''}"
            self.failures.append(msg)
            print(f"  NOT OK - {msg}")
        return cond

    def eq(self, label: str, actual, expected) -> bool:
        return self.check(label, actual == expected, f"got {actual!r}, want {expected!r}")

    def report(self, suite: str) -> int:
        total = self.passed + len(self.failures)
        print(f"\n# {suite}: {self.passed}/{total} checks passed")
        if self.failures:
            print("# failures:")
            for f in self.failures:
                print(f"#   - {f}")
            return 1
        return 0


# --- page helpers -----------------------------------------------------------

def fresh_page(browser, *, width: int = 1400, height: int = 900):
    """A context with no persisted state.

    `helm.workspaces` lives in localStorage, so a reused profile is not a clean
    slate -- see the verify skill's note.
    """
    ctx = browser.new_context(viewport={"width": width, "height": height})
    page = ctx.new_page()
    page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
    return ctx, page


def boot(page, *, url: str = URL) -> None:
    """Load the app and wait until bootstrap has produced its first session."""
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector(".session-item", timeout=30_000)
    # Bootstrap runs initRegistry -> restore -> launch folder -> newSession;
    # give the rAF focus pass a beat, per the verify skill.
    page.wait_for_timeout(400)


def session_rows(page):
    return page.locator(".session-item")


def sidebar_order(page) -> list[str]:
    """Visible session ids, top to bottom -- the sidebar's grouped order."""
    return page.eval_on_selector_all(
        ".session-item",
        "els => els.map(e => e.getAttribute('data-session-id'))",
    )


def sidebar_names(page) -> list[str]:
    return page.eval_on_selector_all(
        ".session-item .session-name",
        "els => els.map(e => e.textContent.trim())",
    )
