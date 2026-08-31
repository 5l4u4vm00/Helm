---
name: verify
description: How to verify Helm frontend changes end-to-end without the Tauri shell — drive the vite dev server with Playwright.
---

# Verifying Helm changes

## Surface

Most Helm logic (stores, agent detection, split groups, sidebar) is pure frontend.
`npm run dev` (vite only, port **1420**, strictPort) renders the full UI in a
browser; PTY spawn and Tauri IPC reject silently, so terminals stay blank but
sessions, workspaces, split groups, toolbars, and panels all work. Only verify via
`npm run tauri dev` (manual) when the change touches Rust (`src-tauri/`), PTY
streaming, or native menus.

## Recipe (Playwright, Python)

Use the webapp-testing skill's `with_server.py`:

```bash
python <webapp-testing>/scripts/with_server.py --server "npm run dev" --port 1420 -- python <script>.py
```

Useful selectors (all stable class names):

- Sidebar: `.workspace-group`, `.workspace-header`, `.workspace-name`,
  `.session-item`, `.session-name`
- Rename inputs: `.workspace-rename-input` / `.session-rename-input`. Enter
  a rename by double-clicking the row/header, or pressing `F2` or `r` while
  it has focus; `Ctrl+A r` renames the active session from anywhere. Enter
  commits, Escape cancels, blur commits. The two are mutually exclusive —
  only one rename input can exist at a time.
- Sidebar buttons (by title attr, Chinese): `新增 Workspace`,
  `在此 Workspace 新增 <launcher>` — the title tracks the default launcher
  name (`Shell`), so match the prefix: `button[title^='在此 Workspace 新增']`
  (opens `.launcher-menu` → `button[role='menuitem']`),
  `刪除 Workspace（連同其下 session）`
- The **active session row** is `.session-item.active` (a class). `data-active`
  is the *pane's* attribute, not the row's.
- Changed files / diff: `.files-panel`, `.file-row` (clickable, `tabIndex=0`),
  and the overlay `.diff-card` with `.diff-row.kind-add|del|ctx`,
  `.diff-hunk`, `.diff-message`, `.diff-banner`.
- Panes: `.pane` with `data-in-layout="true|false"` (false = hidden via CSS,
  Terminal stays mounted), `data-active`, `data-solo` (ungrouped fullscreen:
  no border; the label bar with split/close buttons shows on every pane),
  `.pane-title`; pane split buttons
  `button[title^='向右分割']` / `button[^='向下分割']` (hover the pane first)
- There is no view-mode toggle: the visible layout is the active session's
  split group, or a single solo pane when ungrouped. Splitting (Ctrl+\ /
  Ctrl+Shift+D) creates the group; broadcast targets follow visible sessions.
- Split resizers: `.split-resizer` (drag with mouse.down/move/up)

- The renderer is `CanvasAddon` (see `Terminal/renderer.ts`), so a pane has
  **no `.xterm-rows`** DOM row list to count — the grid is painted into
  `canvas.xterm-text-layer` etc. For geometry read `.xterm-screen`'s box (and
  the canvas layers, which match it) against `.terminal-host`.

## Interaction tests (`tests/e2e/`)

`npm run test:e2e` runs the Playwright suites that cover the integration layer
the node tests cannot reach — pure logic wired to the DOM incorrectly, the class
of bug behind both the v0.20.1 sidebar-drag breakage and the `waitForWidth`
squeeze. Read `tests/e2e/README.md` before adding one; it records what the
browser layer can and cannot prove (notably: Chromium is not WebView2, so the
native-drag failure is not reproducible here).

Gotchas:

- Session titles are not unique (`Shell` repeats) — locate sessions by
  workspace-group index + item index, never by title text.
- Sidebar session order is session-array insertion order, so sessions moved
  from a deleted workspace appear interleaved, not appended.
- Wait ~200ms after clicks; state updates are synchronous but rAF focus and
  re-render need a beat.
- Filter console errors: PTY/Tauri invoke rejections are expected noise in
  browser mode.
- vite may bind **IPv6 (`::1`) only**, so a raw socket probe against
  127.0.0.1 reports the port closed while the server is serving fine. Probe
  over HTTP (`tests/e2e/harness.py` does).
- **`helm.workspaces` now persists in localStorage**, so a run that reuses a
  browser profile is no longer a clean slate. Clear that key (or use a fresh
  `browser.new_context()`) before asserting workspace counts or names.
- Two read-only tricks make browser mode cover far more than it looks:
  (1) seed the stores by dynamically importing them from the page — in dev,
  `await import('/src/store/sessions.ts')` returns the *same* module instance
  the app uses, so `useSessionStore.getState().addChangedFile(...)` works;
  (2) stub `window.__TAURI_INTERNALS__.invoke` via `page.add_init_script` to
  serve canned IPC payloads (e.g. `git_diff_file` fixtures). Include
  `transformCallback` in the stub — `ptySpawn`'s Channel constructor needs it.

## Cheap checks first

- `npm run build` — tsc strict catches signature drift across call sites.
- `node --experimental-strip-types tests/*.test.ts` needs **Node 22**
  (`/c/Users/USER/AppData/Local/nvm/v22.18.0/node.exe`) or `npx tsx`.
