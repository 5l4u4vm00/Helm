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

import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

PORT = 1420

# vite's own port; strictPort is set in vite.config.ts so it never drifts.
SERVER_CMD = "npm run dev"

# Which host actually answers has to be discovered, not assumed. vite may bind
# IPv6 (`::1`) only -- it does on Windows -- while a Linux CI runner typically
# answers on 127.0.0.1. Worse, the two halves of this harness resolve `localhost`
# differently: Python's urllib happily follows it to `::1`, but Chromium tries
# IPv4 first and fails with ERR_CONNECTION_REFUSED. So the probe records the
# literal host that answered and `URL` hands *that* to the browser, keeping both
# halves pointed at the same socket.
_HOST_CANDIDATES = ("127.0.0.1", "[::1]", "localhost")

# Set by _server_up() to the first candidate that answered.
URL = f"http://127.0.0.1:{PORT}"


def _server_up() -> bool:
    """Probe over HTTP, not a raw socket, and pin `URL` to whatever answered.

    HTTP is also the readiness signal we actually care about: the port can be
    open before vite can answer. A raw socket probe additionally lies whenever
    the address family differs -- which silently made an earlier version start a
    second vite that then died on "Port 1420 is already in use".
    """
    global URL
    for host in _HOST_CANDIDATES:
        candidate = f"http://{host}:{PORT}"
        try:
            with urllib.request.urlopen(candidate, timeout=1.5) as r:
                if r.status == 200:
                    URL = candidate
                    return True
        except (urllib.error.URLError, OSError):
            continue
    return False


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill the server *and its children*.

    `shell=True` means `proc` is the shell (`npm`), not vite. Terminating just
    the shell leaves vite holding the port, which on a CI runner orphans a
    process and on a dev box makes the next run silently "reuse" a server built
    from stale code. Kill the whole tree instead.
    """
    if proc.poll() is not None:
        return
    if os.name == "nt":
        # taskkill /T walks the child tree; there is no process-group signal on
        # Windows that Popen(shell=True) would give us.
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
    else:
        # start_new_session put the shell in its own process group, so one
        # signal reaches vite too.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@contextmanager
def dev_server(timeout: float = 90.0):
    """Start `npm run dev` unless something already serves PORT.

    Reusing an already-running server keeps an interactive `npm run dev` usable
    while iterating on these tests.
    """
    if _server_up():
        print(f"[harness] reusing server already at {URL}")
        yield None
        return

    proc = subprocess.Popen(
        SERVER_CMD,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        # Own process group on POSIX (CI), so _kill_tree's killpg reaches vite
        # and not just the shell. Windows uses taskkill /T instead.
        start_new_session=(os.name != "nt"),
    )
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            if _server_up():
                print(f"[harness] dev server up at {URL}")
                break
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise RuntimeError(f"dev server exited early:\n{out}")
            time.sleep(0.3)
        else:
            raise RuntimeError(
                f"dev server did not answer any of "
                f"{_HOST_CANDIDATES} on :{PORT} within {timeout}s"
            )
        yield proc
    finally:
        _kill_tree(proc)


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


def boot(page, *, url: str | None = None) -> None:
    """Load the app and wait until bootstrap has produced its first session.

    Defaults to the module-level `URL` *at call time* -- a default argument would
    capture the pre-probe value and send the browser to the wrong host.
    """
    page.goto(url or URL, wait_until="domcontentloaded")
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
