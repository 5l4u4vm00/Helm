"""Run every interaction suite against one dev server.

    python tests/e2e/run_all.py

Starts `npm run dev` once (or reuses a server already on :1420) and runs each
suite in-process, so the vite startup cost is paid a single time. Exit code is
non-zero if any suite reported a failure -- suitable for CI once a Playwright
step is added to the workflow.

These suites cover the integration layer that `tests/*.test.ts` cannot reach by
construction: pure decisions wired to the DOM. See each module's docstring for
the specific regression it defends.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from harness import dev_server  # noqa: E402

SUITES = ("test_sidebar_drag", "test_pane_sizing")


def main() -> int:
    # One server for every suite. Each suite also opens its own `dev_server()`,
    # which then takes the "reuse" path and does not start a second vite.
    with dev_server():
        failed: list[str] = []
        for name in SUITES:
            print(f"\n===== {name} =====")
            mod = __import__(name)
            try:
                if mod.main() != 0:
                    failed.append(name)
            except Exception as e:  # a crashed suite is a failed suite
                print(f"  SUITE CRASHED: {type(e).__name__}: {e}")
                failed.append(name)

        print("\n" + "=" * 46)
        if failed:
            print(f"FAILED suites: {', '.join(failed)}")
            return 1
        print(f"all {len(SUITES)} interaction suites passed")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
