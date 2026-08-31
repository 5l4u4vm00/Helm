# Changelog

All notable changes to Helm are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was assembled from the published [GitHub Releases](https://github.com/YIHSUAN603/Helm/releases), which remain the canonical record -- each heading links back to its release, where the full notes and the download table for that version live.

## [0.20.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.20.1) - 2026-08-31

_Sidebar dragging works on Windows_

### Fixed

- **Sessions can be dragged in the sidebar on Windows again.** Dragging a session did nothing at all: no insertion line, only a "not allowed" cursor, and the row never moved. The cause was below the sidebar's own code. Tauri's `dragDropEnabled` defaults to true, which registers a native `IDropTarget` on the WebView2 window and swallows every drag reaching the webview — including a drag between two DOM elements on the same page, where `dragstart` fires but `dragover` and `drop` never arrive. Turning that flag off is not available either: the same handler feeds the terminal's file-drop path, whose HTML5 fallback yields a bare file name rather than the absolute path the PTY needs. The sidebar therefore implements dragging with **pointer events**, never touching the native handler, so both features coexist. Two details decide whether it works at all — `setPointerCapture` on the source row once the drag threshold is crossed, and `touch-action: none` on the rows; without them WebView2 starts its own OLE drag on the first pointer move and the event stream stops dead. Both resizers in the app already did this, which was the only difference between the drags that worked and the one that did not.
- **Long session lists scroll while you drag.** Once a row takes pointer capture the list stops scrolling on its own, which made any target outside the visible area unreachable. A pure velocity curve (`autoScroll.ts`, unit-tested) drives a rAF loop near the edges.
- **A drag that loses pointer capture now commits at the current position instead of being discarded.** Losing capture means the captured row was repainted while the pointer was still down — dropping the move silently lost it.

### Changed

- **Dragging a session now only reorders it within its own workspace.** A foreign session is refused during the hover phase rather than at drop: no insertion line and no outline, so "this cannot go here" reads as the absence of a target rather than a move that quietly does nothing. The store's cross-workspace `reorderSession` is untouched — including the invariant that evicts the session from its split group — it simply has no sidebar gesture reaching it, and the keyboard path already clamped at the workspace boundary.

## [0.20.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.20.0) - 2026-08-25

_The sidebar takes the order you give it_

### Added

- **Workspaces and sessions can be reordered in the sidebar.** Drag a session between its siblings, or a workspace header among the other workspaces, and the arrangement persists across launches — workspaces through `helm.workspaces`, sessions through the `sessions.json` snapshot. Neither needed a new `order` field: a workspace's position already *is* its index in `workspaces[]`, and a session's position inside its workspace *is* its index in the global `sessions[]` filtered by `workspaceId`, so reordering is array surgery, kept pure and unit-tested in `store/sidebarOrder.ts`. Because the sidebar's visual order is also the switching order, `Ctrl+A n`/`p` and `Ctrl+A 1..9` now follow whatever arrangement you set — you can put the session you reach for most on `Ctrl+A 1`.
- **`Shift+↑` / `Shift+↓` — or `Shift+K` / `Shift+J` — move the focused row without a mouse.** Shift is the only modifier the sidebar's region key layer allows, which is what rules out the `Alt+↑/↓` other editors use. A move **clamps at the workspace boundary instead of hopping into the next workspace**: crossing one runs the cross-workspace path, which evicts the session from its split group, and an arrow key should not be able to destroy a layout with no undo. Focus stays on the row you moved, so a following `j`/`k` continues from its new position.

### Changed

- **A split group moves as a single block when reordered inside its workspace**, and the insertion line snaps to the group's outer edges rather than pointing between two of its members. A gap inside a rendered cluster is not a real position — the next render pulls the members back together, and the row would land somewhere you never pointed at. Dragging a member to a *different* workspace is unchanged: it still leaves the split group first, preserving the rule that a group never spans workspaces.
- **The sidebar's drop indicators are visible again.** All three — the insertion line, the whole-group outline, and the workspace edge marker — now draw in `--accent`. They had been using `--active`, which is the *selected row background*, a surface grey that is very nearly invisible on the dark themes. The insertion line also gets a `z-index`: it is drawn with a negative margin so it never reflows the rows around it, and that left the next row's background painting over it.
- **Session drags carry a named MIME type** (`application/x-helm-session`, alongside the `text/plain` payload that was already there) and workspace drags carry their own. `getData` is unreadable during `dragover`, so the drop indicator has to decide from `dataTransfer.types` — with a single type, a workspace drag would have been read as a session drop. An unrelated drag from outside the app is now rejected outright instead of showing a move cursor over the sidebar.

## [0.19.3](https://github.com/YIHSUAN603/Helm/releases/tag/v0.19.3) - 2026-08-24

_The seam beside the sidebar closes_

### Fixed

- **The sidebar no longer shows a thin bright seam where it meets the terminal.** The width handle is a 6px transparent hit area meant to straddle the boundary without occupying any layout width, but it only cancelled half of itself: `margin-left: -3px` offsets the handle onto the edge, and with no matching `margin-right` the remaining 3px stayed in the flex row and pushed the terminal away from the sidebar. The gap let the lighter `--app-bg` show through as a vertical line — precisely the permanent divider that v0.19.2 removed on purpose. Both margins are now `-3px`, so the hit area costs nothing and still spans both sides of the boundary.

### Changed

- **`tauri-plugin-single-instance` is registered in release builds only.** A debug build now allows several windows at once, which is what makes it possible to put the same layout side by side under different themes or DPI settings while working on it. Shipped behaviour is untouched: `helm .` and the Explorer right-click entry still focus the running window instead of starting a second copy of the app.

## [0.19.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.19.2) - 2026-08-24

_The sidebar handle stops drawing on itself_

### Added

- **A `CHANGELOG.md`**, assembled from the published GitHub Releases and covering every version back to the first. The releases remain the canonical record — each heading links to its own release page, where the full notes and that version's download table live.

### Changed

- **The sidebar width handle no longer draws a centre line** in any state — hover, drag, or keyboard focus. The 6px hit area and the drag behaviour are unchanged; the `col-resize` cursor is already the affordance, and an accent-coloured 2px line appearing under the pointer was the loudest thing on screen in a dark theme, right next to a border that was deliberately removed for the same reason. `:focus-visible { outline: none }` stays, so the browser default frame does not step in to replace what was just taken out.

## [0.19.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.19.1) - 2026-08-24

_The workspace actions come back to one line_

### Changed

- **All four workspace actions are back on the header line**, ordered settings → create → destroy, revealed on hover or keyboard focus of the header. The folder and recipe buttons keep their accent tint at rest, because "this workspace has a folder" is information rather than an action.
- **Group membership is shown by a left rail, not by indentation.** A few px of padding is a weak signal; a continuous vertical line makes it obvious at a glance which sessions belong to which workspace, and it stops costing the session titles their width. Only the focused workspace lights its rail in the accent color — six lit rails would be the same as none.
- **The active session row is the loudest thing in the list**, with an accent edge in the rail, full-contrast text and a heavier weight. Split-group connector brackets moved into that same rail track; at their old position they sat a few px from the workspace rail and the two read as one smudged double line.
- **Workspace names render as 10px letter-spaced uppercase** so they read as section labels one level above the sentence-case session titles, and only the focused workspace gets full contrast. Status dots shrank from 8px to 6px — with a glow attached, 8px was competing with the session name it labels.
- **Groups are separated by space rather than rules**, and the panel's own `SESSIONS` label steps back: it never changes, so it should lose to every workspace name under it.

### Fixed

- **Workspace names and folder paths no longer get clipped from the tail.** The truncation budgets were calibrated against the old type sizes and row contents, and were too generous once those changed — so CSS reached the string first and cut the end off, discarding exactly the trailing half that middle-eliding exists to preserve. Both budgets are now derived from measured values (the name box is `sidebarWidth - 124 - 20 × always-on badges` px, its font averaging 6.83px per uppercase character) instead of estimates.
- **Buttons that stay visible at rest are now charged against the name's width.** The folder and recipe buttons keep their tint after the pointer leaves, and the approval badge stays until the prompt is answered; each costs 20px. A workspace with a folder set is permanently narrower than one without, so the budget takes a per-row badge count rather than folding a fixed reserve into every row.
- **The name budget's floor is 5 characters, not lower.** Below 5, middle-eliding returns the string untouched, so a smaller floor did not mean "elide harder" — it meant no eliding at all, and the whole name spilled out for CSS to clip. The CSS `min-width` is pinned to match, so the two halves cannot disagree at the minimum sidebar width.

## [0.19.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.19.0) - 2026-08-21

_A sidebar you can actually read_

### Added

- **Drag the sidebar to any width you like** — the width is a setting (`helm.sidebarWidth`, clamped 180–480, default 220), so it persists across launches. The new `SidebarResizer` reuses the pointer-capture pattern the split resizers already use, and supports dragging, arrow-key nudging, and double-click to reset. It is deliberately a *sibling* of `.sidebar` with its own `tabIndex`: the sidebar's region key layer already spends `h`/`l`/arrows on collapse/expand, so a handle living inside the sidebar would collide with those bindings.

### Changed

- **Workspace action buttons (📁 ⚙ ＋ ×) moved to a second row**, expanding on hover/focus so the first row carries information only. Visibility is driven solely by the container's `display` rather than stacking a second mechanism on top of the hover-action opacity. The trigger is bound to `.workspace-group` instead of the header — on the header, moving the cursor onto a button would make the button row vanish underneath it.
- **Workspace names now truncate in the middle** (new `middleEllipsis`), keeping both the beginning and the end visible — for names like `client-alpha/…/frontend`, the halves that identify it.
- **Path truncation adapts to the sidebar width.** `displayFolderPath`'s 30-character budget was calibrated against 220px; once the width is adjustable that premise no longer holds, so the budget is now derived from the actual width by `sidebarCharBudget`, with a tighter `workspaceNameBudget` for the name row, which also has to share space with the chevron, session count and waiting badge.
- **Session title tooltips carry the full title plus the rename hint**, following the same "value + hint" wording the folder row already used. `.session-name` also picked up the `min-width: 0` it was missing, without which flex refuses to shrink the label and the ellipsis never appears. **Known trade-off:** hovering a workspace makes it taller, so the session list below shifts down. That is the price of giving the workspace name the full row width.

## [0.18.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.18.2) - 2026-08-12

_Windows file diffs work again_

### Fixed

- **Every file diff on Windows reported `not_a_repo`** — `resolve_abs` canonicalizes the target path, and on Windows `canonicalize` returns the verbatim `\\?\C:\...` form, while `git rev-parse --show-toplevel` returns a plain `C:/...`. `to_repo_relative` compares the two with `strip_prefix`, so the prefix made that comparison fail for **every** lookup — the diff overlay was effectively dead on Windows, for tracked and untracked files alike. Both sides are now normalized: `strip_unc` (already used for launch folders, now `pub(crate)`) is applied to the resolved path, and git's own answer is canonicalized too, so a symlinked worktree or an 8.3-shortened checkout can't disagree with it either.
- **Scan-sourced diffs resolved against the wrong repository** — `DiffViewer` called `resolveDiffBase` with no session, so entries found by the viewport scanner (whose paths are relative, sometimes a bare basename) skipped the session's own `cwd` and fell through to the global `defaultCwd` — a different repository, or empty, which surfaces as "unresolvable". The session is now read via `getState()` rather than a subscription, since a session's `cwd` is fixed at creation and re-rendering on every streaming edit would buy nothing. The existing unit test hand-wrote both paths, so it never saw what `canonicalize` actually produces — that is exactly how this got through. A regression test now goes through the real filesystem.

## [0.18.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.18.1) - 2026-08-12

### Fixed

- A patch release for two visible glitches: scrollback snapshots that had Helm's own replay banner baked into them, and Windows paths in the sidebar that looked scrambled.
- **Corrupted scrollback snapshots are now discarded and self-heal** — before v0.18.0's width fix, a pane replaying at a collapsed width (14 or 28 columns in practice) wrapped the replay banner across two or three physical rows. The scan floor counts absolute rows and only covered part of it, so a truncated header tail (`ssion ──`) plus the footer and resume hint were saved back into the snapshot file. That earlier fix only stopped *new* bad files from being written — **existing files stayed on disk** and kept replaying, stacking another layer on every launch. Now a snapshot containing the banner is discarded on read, so the next poll overwrites it with a clean screen and old files repair themselves without you deleting anything. A second check before writing catches the case where line wrapping throws the floor off; writing nothing deliberately does not delete the existing file, so the worst case is keeping the older snapshot. The detection deliberately matches Helm's own banner text *and* requires `──`, rather than a "starts and ends with `──`" shape rule — that rule would also eat ordinary output like `─── Coverage summary ───`, and a false positive throws away your real history, which is far worse than missing one.
- **Long folder paths in the sidebar are truncated from the front instead of reordered** — the workspace folder and diff header used `direction: rtl` to keep the tail of a path visible, but that flips the paragraph's base direction, so the bidi algorithm reorders the LTR segments inside the path and puts the ellipsis on the wrong side. Windows paths ended up looking out of order and jammed against the left edge. A new pure `displayFolderPath` trims from the head and keeps the string plain LTR; the full path is still in the hover tooltip.

## [0.18.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.18.0) - 2026-08-10

_Per-workspace startup, and files you can drag in_

### Added

- **Workspace startup recipe** — the sidebar header's new **⚙** button edits an `env` map and a startup `command`, stored alongside the workspace's folder. New sessions in that workspace inherit both. The two halves deliberately reach different paths: `env` is inert until something reads it, so it applies everywhere a PTY spawns (including restored sessions, where it travels in the snapshot next to `cwd`); `command` *executes*, so it is confined to explicit new-session paths — `helm .`, the Explorer entry and restore-on-launch never run it. Picking a launcher from the menu is the more specific intent, so its command wins over the recipe's; `env` applies either way. `HELM_SESSION_ID`, `HELM_EVENT_PORT` and `TERM` can never be overridden — a recipe resetting the first two would misroute hook events and silently kill agent awareness.
- **Drag files from the file manager into a pane** — dropping a file writes its quoted absolute path into that pane's PTY as keyboard input, so a CLI agent can read it. **Enter is deliberately not sent**: a path is usually part of a sentence, and submitting on your behalf can't be taken back. Quoting is per-platform (Windows treats backslashes inside double quotes literally; POSIX uses single quotes so `$` and backticks don't expand), and control characters are stripped before writing — a stray CR would amount to pressing Enter for you. The drop lands in whichever pane is under the cursor, using the same geometry the layout already computed.

### Fixed

- **Restored hidden panes no longer replay their scrollback at a collapsed width** — on restore only the active session's pane is laid out; the rest are `display:none` and measure 0×0, which clamped the terminal grid to a minimum like 9×5. Because replayed lines carry hard line breaks, that width was permanently burned into the buffer — showing the pane later couldn't undo it. Replay now waits for the container to have a real width (up to 2s) and hidden panes keep xterm's 80×24 default instead of being squeezed.
- **Windows now publishes only the NSIS installer** — the Explorer "Open with Helm" entries are registered by an NSIS install hook that an MSI build never runs, so anyone who downloaded the `.msi` got an installer silently missing that feature. Only `Helm_0.18.0_x64-setup.exe` is published for Windows from this version on.

## [0.17.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.17.0) - 2026-08-07

_Open Helm in a folder_

### Added

- **`helm <folder>` on the command line** — a relative argument resolves against the directory you ran it from, a *file* argument opens its parent folder, and a path that doesn't exist is ignored rather than passed through to the shell. The folder becomes the session's working directory, so the shell simply starts there; no `cd` is typed into the terminal, which would otherwise race with your shell's own startup and clutter the scrollback.
- **Explorer context menu (Windows)** — the installer registers two entries: right-clicking a folder, and right-clicking empty space *inside* a folder. Both are written under `HKCU`, so no administrator rights are needed. They're added by a fresh install of this version.
- **Second launch focuses the existing window** — running `helm .` again while Helm is open no longer starts a second copy of the app. The running window comes to the front and adds the new folder's session. Workspaces bound to the same folder are matched by a normalized path comparison, folding separator style and trailing slashes (and letter case on Windows), so `C:\repo`, `C:/repo/` and `c:\repo` all land in one workspace. See the assets below to download and install this version.

## [0.16.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.16.2) - 2026-08-06

_Double-click rename works again on Linux_

### Fixed

- **Double-click rename on WebKitGTK** — `SessionItem` now starts the rename on the second `mousedown` (`detail === 2`) instead of waiting for a `dblclick` that the drag machinery swallows. Two focus paths that would immediately close the fresh input are also suppressed while a rename is open: `activateSession`'s `requestAnimationFrame` focus grab and `Terminal`'s focused effect — either one would blur the input and commit it before you could type. Keyboard rename (`F2` / `r` in the sidebar, `Ctrl+A r`) was unaffected and continues to work. See the assets below to download and install this version.

## [0.16.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.16.1) - 2026-08-05

_The close button works again_

### Fixed

- **Closing the window quits the app again** — `core:window:allow-destroy` is granted, and every path through the close handler now reaches `destroy()`. The snapshot flush is wrapped in a catch plus a 2s timeout (a slow or failing write must not hold the window open — the snapshot is designed to be correct-when-stale), a repeat close request skips the flush but still destroys, and a failing `destroy()` is logged instead of swallowed: on screen that failure looks like nothing happening. A new test scans the frontend for window API calls and fails when the capability does not grant one — type checking cannot see these, and `allow-set-focus` / `allow-unminimize` were both added the same way, after hitting the runtime rejection.

### Internal

- **Manual statusline integration** — Settings only offers one-click install when no `statusLine` is set, so a user with their own statusline had no documented path. The README now carries the forwarding snippet plus the four rules behind it (read stdin once, forward the payload unchanged, keep the source string exact, stay quiet and bounded), and notes that the status keeps reading "custom" because that check looks for Helm's own script path rather than for the forwarding. **If you are on v0.16.0** and the window will not close, ⌘Q (or Quit from the menu) still works — this release fixes the button. See the assets below to download and install this version.

## [0.16.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.16.0) - 2026-08-05

_Your workspace survives a restart_

### Added

- **Cold restore of sessions and split layout** — the session list and split-group geometry are snapshotted to `sessions.json` and rebuilt at startup. Cost, tokens, changed files, agent state and pending approvals are structurally excluded from the file, so a ghost "waiting for your approval" prompt cannot survive a restart. A launch command is remembered but never re-run silently on restore.
- **Scrollback snapshot and replay** — each pane's normal buffer is stored as plain text and replayed inside a dimmed frame that says how long ago it was captured. Replay bypasses the scan pipeline entirely, so a request you already answered can't be re-detected as an active approval.
- **Resume agent conversations** — Helm now collects the agent's own session id from hook payloads and offers a resume button that runs the CLI's real resume command (`claude --resume <id>`, falling back to `claude --continue` when no id is known). Agents that don't support resuming show no button rather than a command that might silently attach to the wrong conversation, and resuming is blocked outright if the pane's working directory has gone missing — resume is scoped by directory, so the wrong directory means the wrong repo. Optional auto-resume on launch is off by default.
- **Notification history is kept on disk** — the notification center was memory-only, so the record of what your agents did overnight was gone by morning. Events now append to `events.jsonl` and are read back at boot as already-read entries. A corrupt line drops only that line.
- **Stall detection** — `interrupted` only catches a PTY that actually died. A process that is alive but stuck (an agent waiting on a request that never returns, a dropped connection) produced no event at all, and silence looks exactly like progress on screen. A watchdog now flags a session that has been busy and silent for five minutes.
- **Terminal renderer fallback completed** — the canvas renderer had no handling for `contextlost` (GPU process restarts and memory pressure both trigger it); the symptom was a pane that simply stopped repainting. Losing the context now drops the addon and falls back to xterm's built-in DOM renderer with a full repaint.
- **Install via Homebrew on macOS** — `brew tap YIHSUAN603/tap` then `brew install --cask helm-terminal`. The cask is regenerated automatically whenever a release is published, and it clears the quarantine flag (macOS builds are ad-hoc signed, not notarized).

### Fixed

- **Bootstrap no longer aborts without a Tauri runtime** — `getCurrentWindow()` throws *synchronously* when there is no Tauri runtime rather than returning a rejecting promise, so a `.catch()` never saw it. Because it ran before session creation, browser-only `npm run dev` started with no session at all. The same class of bug applied to `ptyKill`, where the thrown error aborted the terminal's cleanup halfway and left xterm erroring against a torn-down viewport.
- **Restored panes no longer accumulate their own resume command** — the snapshot preferred the pane's live launch command over the carried one, so each restart pushed the original one level further out (`claude` → `claude --resume X` → …) until even relaunching meant resuming a stale id. See the assets below to download and install this version.

## [0.15.5](https://github.com/YIHSUAN603/Helm/releases/tag/v0.15.5) - 2026-08-04

_Codex notification signals stop lying_

### Fixed

- **Terminal progress sequences no longer force a false "done"** — OSC 9 is shared by two unrelated protocols: desktop notifications (what Codex uses) and ConEmu / Windows Terminal progress reporting (`9;4;<state>;<pct>`). Helm forwarded both into the notification path, where any message that isn't an approval request is treated as turn-complete. So on a Codex session, *any* program emitting a progress sequence — common on Windows — marked the turn finished, cleared a pending approval, and turned the status light green while you were still being asked to approve something. Progress subcommands `9;1`–`9;4` are now dropped before they reach state detection; real notifications that merely start with a digit (`"3 files changed"`) still get through.
- **Codex OSC 9 detection now parses the TOML instead of scanning lines** — the "Agent integrations" check for `~/.codex/config.toml` compared strings line by line without tracking which `[table]` it was in, prefix-matched keys, and substring-matched values. It reported "configured" for `notification_method = "not-osc9"`, for `notification_method_fallback = "osc9"`, for a trailing comment `# osc9`, and for the keys sitting under any other table entirely — a false green being the worst outcome, since the setup banner is suppressed and the notifications never arrive. Conversely it reported "not configured" for legitimate dotted-key and inline-table spellings, nagging users who had it right. It now parses the file properly, and honors `CODEX_HOME`. See the assets below to download and install this version.

## [0.15.3](https://github.com/YIHSUAN603/Helm/releases/tag/v0.15.3) - 2026-08-03

_Pane splits inherit their workspace folder_

### Changed

- **Busy sessions pulse blue in the sidebar** — the busy status dot was the same green as idle-but-done, which made a working session hard to spot at a glance. It's now blue with a slow pulse. See the assets below to download and install this version.

### Fixed

- **Splitting from a pane label now inherits the workspace folder** — the split buttons on a pane's label created the new session without a working directory, so its shell (and any agent launched into it) started in the default folder instead of the workspace's. Splitting via `Ctrl+A "` / `Ctrl+A %` was unaffected; both paths now share one code path.

## [0.15.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.15.2) - 2026-08-03

_Terminal search and mouse-friendly confirmations_

### Added

- **Terminal buffer search** — search the scrollback with match highlighting, plus a configurable scrollback line count and support for clickable links and wide characters.
- **Codex `Action Required` detection** — Codex 0.146.0 advertises a blocked turn in its terminal title (`[ ! ] Action Required`) and sends an OSC 9 notification for plan-mode prompts. Helm now reads both, so a waiting Codex session lights up even when the on-screen text has drifted. Because a title can't reveal whether Codex wants an approval or an answer, these sessions are flagged as questions and deliberately show no one-click approve button.
- **Mouse-completable delete confirmations** — the sidebar's inline "Close this session?" / "Delete this workspace?" confirmations now show ✓ / ✕ buttons, so they no longer require pressing Enter or Esc. Clicking anywhere else on the row cancels, mirroring the keyboard behavior.

### Changed

- **The approval panel lists approvals only again** — question-type prompts can't be answered from the panel, only from the terminal, so mixing them in blurred the panel's meaning and skewed the batch-approve count. Questions still reach you through notifications and the sidebar.

### Fixed

- **README no longer claims automatic update installation** — Helm notifies you about updates but does not install them for you; the docs said otherwise. See the assets below to download and install this version.

## [0.15.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.15.1) - 2026-07-29

_Collapsible approval panel_

### Added

- **Collapse / expand the approval panel** — a new toggle button on the approval panel header, bound to `Ctrl+A h`, hides the panel when you want the terminal to fill the view and brings it back on demand.

### Fixed

- **Shortcut-doc generator no longer fails silently** — the `docs:shortcuts` generation script was silently skipped when the repo path contained a space; the path is now quoted so it runs correctly. See the assets below to download and install this version.

## [0.15.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.15.0) - 2026-07-27

_Keyboard input, restructured into four layers_

### Added

- **Four keyboard layers, one rule each** — *global* handles only `Ctrl+A` prefix sequences (plus `⌘⇧P`), *region* accepts bare keys only (Ctrl/Alt/Meta now bail out), *modal* routes every `Escape` through one dismiss path that returns focus to whatever opened the dialog, and everything else reaches the terminal untouched.
- **`Ctrl+A` stays select-all in text fields** — arming the prefix is suppressed while focus is in a real input, so renaming a session, searching the command palette, and editing settings all behave normally again.
- **New prefix bindings** — `Ctrl+A b` (notification center), `Ctrl+A i` (back to terminal), `Ctrl+A ?` (shortcut help), and `Ctrl+A Ctrl+y` / `Ctrl+A Ctrl+n` to approve or reject an entire workspace.
- **Shortcut help dialog** — a searchable reference generated from the actual keymaps, reachable via `Ctrl+A ?`, the sidebar `?` button, or the Help menu; the README block is generated from the same source.
- **Sidebar keys aligned with the global layer** — `c`/`w`/`x`/`r` on a focused row now mirror `Ctrl+A c`/`w`/`x`/`r`.
- **Native menu discoverability** — menu labels carry their `(Ctrl+A x)` hints, and a Help menu was added. A unit test now fails the build if a binding is undocumented, an i18n string is missing in either language, the README block goes stale, or a menu hint disagrees with its keymap label — so the reference can't drift from the implementation. See the assets below to download and install this version.

## [0.14.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.14.2) - 2026-07-27

_Sidebar keyboard navigation, redesigned_

### Added

- **Unified Vim-style tree navigation** for workspaces and sessions — `h`/`l` (or ←/→) to collapse, expand, and enter items; `j`/`k` and arrows to move focus; `Enter`/`Space` to activate a session or toggle a workspace.
- **Inline delete confirmation** — pressing `Delete`/`Backspace` on a session or workspace now asks for confirmation in place (`Enter` to confirm · `Esc` to cancel), including a count of sessions a workspace will take with it.
- **Discoverable shortcuts** — a sidebar shortcut help panel and consistent key mapping across workspace and session rows.
- **Quick actions from focus** — `r`/`F2` rename, `a` new session, `A` new workspace, `f` set folder, `Esc` jumps focus back to the terminal.
- Fully localized copy (English / 繁體中文) and shortcut-mapping unit tests. See the assets below to download and install this version.

## [0.14.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.14.1) - 2026-07-26

### Added

- **Set a workspace folder from the keyboard.** Focus a workspace header in the sidebar and press `f` to choose its default folder, without opening a menu.

### Fixed

- **Claude Code plan usage and the active agent's session stats now appear side by side.** Viewing a Codex session no longer hides your Claude Code plan allowance.
- **The pending-input panel now includes questions as well as approvals.** Questions show an `Answer` action that takes you directly to the relevant session; approval batch actions remain limited to actual approvals.

## [0.14.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.14.0) - 2026-07-26

### Added

- **Click a changed file to see its diff.** The changed-files panel's rows are now buttons: clicking one opens a read-only diff of that file against the last commit, right inside Helm, so reviewing what an agent did doesn't mean switching to another tool. `[` and `]` step through the files, `Esc` closes. It is strictly read-only — Helm only ever runs `git rev-parse`, `diff`, and `status`, never stages, commits, or edits, and untracked files get a synthesized patch rather than being touched with `git add -N`.
- **Workspaces are remembered between launches.** Your workspace list — names, default folders, and collapsed state — is persisted, so the layout you set up is still there next time you open Helm. Sessions deliberately are not: every launch still starts with one fresh session.
- **Rename a session.** Double-click a session in the sidebar, or select it and press `F2` or `r`; `Ctrl+A r` renames the active one from anywhere, and there's a command-palette entry too. Handy when three sessions are all just called `claude`. An explicit name sticks — Claude Code rewrites its terminal title on every spinner tick, and that no longer overwrites your label. Clear the name to hand control back to the agent's automatic title.
- **A workspace folder that isn't there any more says so.** A persisted folder can point at an unmounted volume or a project you've moved. Helm now checks, shows the path struck through in the sidebar, and starts new sessions in your home directory instead — and deliberately does *not* auto-run the agent command on that fallback, so an agent never silently starts against the wrong repo.

### Fixed

- **Panes no longer under-count their rows after a resize.** Dragging a split divider could leave the terminal fitted to the pre-resize geometry; Helm now re-fits once the resize settles, so the PTY sees the size you actually dragged to.

## [0.13.3](https://github.com/YIHSUAN603/Helm/releases/tag/v0.13.3) - 2026-07-24

### Fixed

- **Custom background image now displays.** The image chosen in Settings is loaded by Rust into an in-memory `data:` URL instead of going through the Tauri asset protocol, so it renders reliably behind all chrome — including from external drives — without hitting the asset protocol's scope limits.

## [0.13.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.13.2) - 2026-07-24

### Added

- **Custom background image with adjustable dim overlay.** Choose an image file as an app-wide background, rendered behind all chrome via the asset protocol. A 0–100 dim slider controls a readability overlay, and terminal panes turn transparent so the image shows through the gaps between splits. Both the image and the dim level persist across launches.

## [0.13.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.13.1) - 2026-07-24

### Added

- **Deleting a workspace now closes its sessions.** Previously, removing a workspace moved its sessions into the default workspace, leaving their PTYs (and any running agents) alive and cluttering the sidebar. Deleting a workspace now closes every session inside it, so the panes unmount and their PTYs terminate — deleting a workspace means the whole group is gone.

## [0.13.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.13.0) - 2026-07-22

### Added

- **Fleet status strip in the toolbar.** The toolbar's left side now shows the whole fleet at once: chips for running, waiting, error, and done, each appearing only when its count is nonzero. Clicking a chip jumps to the next session in that state in sidebar order and wraps around, so repeated clicks cycle through all of them — useful when several agents are waiting and you want to work through them without hunting in the sidebar.
- **Plan usage is account-wide.** The 5h/weekly rate-limit meters read from the latest statusline data of any session rather than only the active one, so they stay visible whenever Helm knows them instead of blanking out when you switch to a session that hasn't reported yet.

### Fixed

- **Claude Code statusline integration works on macOS.** The installed `statusLine` command path was written unquoted, and Claude Code runs it through a shell — so on macOS the path broke at the space in "Application Support" and the statusline died with exit 127, meaning no cost, token, or context data ever reached Helm. The path is now quoted, and reinstalling from Settings → Agent integrations rewrites an existing Helm entry to repair an old broken install. If you installed the statusline before this release, reinstall it once.

### Removed

- **Broadcast box.** The toolbar's broadcast input, its target selector, and the `Ctrl+A b` shortcut are gone, replaced by the fleet status strip. Sending the same text to several agents at once was rarely the useful part of managing a fleet — knowing which ones need attention, and getting to them fast, was.

## [0.12.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.12.0) - 2026-07-22

### Added

- **OSC 52 clipboard copy from TUIs.** Copying inside nvim, tmux, and other TUIs that use the OSC 52 escape sequence now reaches the system clipboard — xterm.js doesn't implement it, so yanks inside Helm were silently dropped. Write-only by design: clipboard read queries are ignored, so a program running in the terminal can never read your clipboard (pasting already works via Cmd+V / bracketed paste).

### Fixed

- **Collapsed and empty workspaces are keyboard-reachable again.** `j`/`k` in the sidebar now stop on workspace headers that have no visible session rows (collapsed or empty), so every workspace can be reached without the mouse; headers with visible sessions are still skipped and entered via `h`/`l`.
- **Visible focus ring in the sidebar.** macOS WKWebView never shows `:focus-visible` for script-moved focus, leaving the sidebar's roving focus invisible — session rows, workspace headers, and launcher menu items now draw an inset outline on focus.

## [0.11.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.11.0) - 2026-07-19

### Added

- **macOS notification health surfaced in Settings.** When system notification authorization fails (unsigned build, permission denied), Helm silently fell back to AppleScript notifications that are attributed to Script Editor and can't focus Helm when clicked. Settings now shows a warning under the notifications toggle with the exact failure reason and an "Open System Settings" button that jumps straight to the notification permissions pane. Helm also re-requests authorization on each notification, so granting the permission later heals native notifications immediately — no restart needed.
- **Smoother sidebar navigation.** `j`/`k` (and `↑`/`↓`) now move only between session rows, skipping workspace headers — headers are still entered and left with `h`/`l`. From a focused header, `j`/`k` bridges to the nearest session row, and `Ctrl+A g` expands the active session's workspace before focusing the sidebar so you always land on a session row.

## [0.10.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.10.0) - 2026-07-17

### Added

- **Keyboard-driven sidebar with vim-friendly navigation.** `Ctrl+A g` jumps focus into the sidebar (unhiding it first if collapsed), and `Ctrl+A ←` overflows into the sidebar from the leftmost pane, vim-tmux-navigator style. Once there, navigate with vim keys — `j`/`k` move up/down and `g`/`G` jump to the ends (also in the pane launcher menu), while `h`/`l` (or `←`/`→`) collapse/expand a workspace, dive into its first session, or jump back from a session to its header. Rows have action keys too: `d` closes a session, `r` renames a workspace, `a` adds a session to it.
- **Shell-only default launchers.** The launcher menu no longer ships with built-in Claude Code, Codex, or demo entries — just Shell. Add your own launchers in `agents.json` (the template it generates is now empty).

### Fixed

- **Bottom terminal row no longer clipped.** The 8px pane padding sat on the wrong element, so the fit logic overestimated the available height by 16px — it computed one extra row that was then cut off by the pane edge. The padding now lives on the terminal element itself, where the fit calculation accounts for it.

## [0.8.0](https://github.com/YIHSUAN603/Helm/releases/tag/untagged-90617b532c5a038e1e18) - 2026-07-16

### Added

- **Collapsible sidebar.** A « button on the sidebar header edge (or `Ctrl+A e`, the View menu, and the command palette) hides the session sidebar to free up terminal width. While hidden, a ☰ button at the toolbar's left end brings it back. Like the rest of the layout, the state is not persisted across launches.
- **Notifications for off-screen panes.** While the window is focused, a session waiting for approval or hitting an error now triggers a desktop notification if its pane is not visible on screen — e.g. it's outside the active split group, or the sidebar is collapsed. Previously the whole focused workspace was suppressed, so a hidden pane could block on an approval without you ever noticing. A new "hidden panes" toggle in Settings (default on) restores the old behavior when disabled.

### Fixed

- **macOS notifications actually deliver now.** `UNUserNotificationCenter` only works for code-signed apps, and the bundle was never signed — so the permission prompt never appeared and every notification was silently dropped. The app is now ad-hoc signed in both local and CI builds, authorization failures are logged instead of swallowed, and unsigned/denied environments fall back to the osascript path.
- **Terminal grid is vertically centered.** The rounding remainder from fitting rows into the pane height used to pile up as a bottom gap that grew with window height; the leftover space now splits evenly above and below the grid (like kitty/alacritty).
- **Download links and updater endpoint fixed.** README links and the auto-updater endpoint pointed at an account that no longer exists, returning 404s and breaking auto-update. Both now point at the current repository.

## [0.7.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.7.0) - 2026-07-14

### Added

- **Notification center.** A bell button in the toolbar (with an unread badge) opens a panel collecting every agent alert — approval prompts, questions, plan reviews, task completion, and errors. Clicking an entry jumps to that session; pending-approval entries resolve automatically once the prompt is answered. The list keeps the latest 50 alerts and lives in memory only.
- **Notifications for done and error.** Desktop notifications now also fire when an agent finishes or hits an error, not just when it waits for approval. Three per-type switches (approvals / done / errors) in Settings let you pick exactly which alerts reach your desktop, under the existing master toggle.
- **Tabbed Settings dialog.** Settings are reorganized into four tabs — General, Appearance, Agent integrations, and About — with the custom theme editor now housed under Appearance.

### Changed

- The sidebar workspace badge now counts every waiting session — questions and plan reviews included, not just approvals — and clicking it cycles through them.
- Theme "Dark/Light" labels are properly localized in the English UI, and the updater no longer shows a raw translation key when the app is up to date.

## [0.6.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.6.2) - 2026-07-14

### Added

- **Custom color themes.** Create any number of named themes from the Settings dialog — "New custom theme from current" copies the active theme as a starting point, then color pickers let you tune the 9 interface colors, the 4 terminal base colors (background, foreground, cursor, selection), and the full 16-color ANSI palette, all applied live. Themes are stored locally and can be renamed or deleted at any time.
- **Desktop notifications toggle.** A new "Desktop notifications" switch in Settings lets you turn off approval-prompt notifications entirely (on by default). The setting persists across launches.

### Changed

- New app icon across all platforms and sizes.

## [0.6.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.6.1) - 2026-07-13

### Added

- **Codex OSC 9 setup hint.** When a session is detected as Codex but its `config.toml` doesn't have OSC 9 desktop notifications enabled, a small banner appears in the corner of the terminal with an "Open settings" shortcut straight to the Agent integrations section (including the copyable `config.toml` snippet). Dismissing it with × remembers your choice permanently; Helm still never edits `~/.codex/config.toml` for you.

### Fixed

- **Key repeat on macOS.** Holding a key now repeats instead of popping the press-and-hold accent picker — Helm opts its own defaults domain out of `ApplePressAndHoldEnabled` before the webview is created, so your global macOS setting is untouched.
- **Terminal opening at the wrong size.** All resize paths (font loading, font/settings changes, pane visibility changes) now reach the PTY through a single sync point, with an authoritative sync after spawn. This fixes Claude Code rendering at a stale, too-short height on a macOS cold start.

### Internal

- Removed the agent label tag from pane labels and the sidebar — the status dot already conveys agent state, and the tag added visual noise.
- Removed the "response may not have registered" hint from the approval panel; official hook-sourced prompts made it redundant.

## [0.6.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.6.0) - 2026-07-12

### Added

- **Claude Code plan usage in the toolbar.** For Pro/Max accounts, Helm now shows your remaining rate limit (5-hour and weekly %, with the reset time in the tooltip), parsed from the statusline `rate_limits` payload. It's account-level, so the figure is shared across every session.
- **Bundled Nerd Font symbols.** Helm now ships *Symbols Nerd Font Mono* as the trailing fallback in the terminal font-family chain, so Nerd Font glyphs (Neovim / TUI Private Use Area icons) render regardless of your chosen primary font — no separate font install required.

### Fixed

- **macOS 26 notifications.** macOS notifications now use the modern `UserNotifications` framework (`UNUserNotificationCenter`), replacing the `NSUserNotification` API that was removed in macOS 26. Unbundled dev builds fall back to `osascript` (shows the notification, though without click-through).
- **"Picked a font, nothing changed" / blank icons.** Changing the terminal font now clears the glyph atlas and repaints — on font change *and* cold start — so a newly selected font takes effect immediately and previously-blank Nerd Font icons appear.

### Internal

- Bumped the version across `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock`.
- Ignore exFAT AppleDouble files (`._*`) and the machine-specific `src-tauri/.cargo` config.
- Fixed a `cargo fmt --check` failure (import ordering in `notify.rs`) and bumped the CI/release workflows to `actions/checkout@v5` + `actions/setup-node@v5` (off the deprecated Node.js 20 runtime).
- Added node-tested coverage for the new rate-limit hook parsing and font-family fallback.

## [0.5.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.5.0) - 2026-07-10

### Added

- Official hook-driven agent awareness (opt-in, one click). Helm now runs a tiny local hook server; every PTY is injected with a session id and event port, and Claude Code / Codex hook processes POST their events straight back. PermissionRequest → an exact tool_name: tool_input approval prompt, Stop → done, PostToolUse → changed files, and Claude Code’s statusline JSON → cost & remaining context. Enable it from the new Settings → Agent integrations section, which idempotently merges into ~/.claude/settings.json (never touching your existing entries) and shows a copyable config.toml snippet for Codex.
- Codex desktop notifications (OSC 9). Codex’s tui.notifications are parsed directly, so approval/waiting alerts fire even without hooks.
- Codex menu-style approvals & remaining context. Helm now recognizes Codex’s arrow/numbered approval and question menus, sends Esc to reject (so a stray n can’t land on the highlighted Yes), and surfaces Codex’s “72% context left” in the toolbar when token counts aren’t available.
- Terminal-title busy/rest signal. The OSC 0/2 title (the spinner CLIs set themselves) now refines state classification — vetoing false done/error while an agent is working, and clearing leftover “thinking” once it’s at rest.
- File changes captured from the viewport. Alt-screen TUIs (Claude Code 2.1+) repaint with almost no newlines, so the line-by-line stream never sees their ⏺ Update(...) lines; changed files are now extracted from the visible viewport as well (deduped by path).

### Fixed

- Panels no longer overflow on short windows. The approval, command, and changed-files panels now use a fixed header with internal scrolling and aligned box-sizing.
- Claude Code detection recalibrated to current TUI output (2.1.206) — ● bullets and randomized completion verbs.

### Internal

- Synced package-lock.json to 0.5.0 (it had lagged at 0.3.5) and dropped a stale @tauri-apps/plugin-notification entry.
- Added node-tested normalization for hook events plus engine/extract coverage, and resolved a clippy -D warnings failure in the hook-server tests.

## [0.4.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.4.1) - 2026-07-09

_Agent-aware terminal — each session is a PTY, and Helm passively detects the_

### Added

- **Per-workspace default folder** — each workspace can now set its own default folder (📁 in the workspace header); new sessions created in that workspace spawn in that directory, falling back to the global default when unset.
- **Click a notification to jump to the session** — clicking a desktop notification now raises the Helm window and switches to the exact session that triggered it.
- **Notify on Claude Code free-text questions** — you're now alerted when Claude Code asks an open-ended (free-text) question, not only on approval menus.
- **More readable sidebar** — workspace/section titles use the foreground color for better contrast.

### Fixed

- **Full-width “？” prompts detected as waiting** — question menus using the full-width CJK question mark are now correctly recognized as an awaiting-input state.
- **Idle asterisks no longer mask “done”** — decorative idle-animation asterisks stopped a finished agent from being reported as done; the done state now shows through.
- **macOS builds restored** — fixed a `mac-notification-sys` API signature mismatch that broke the macOS release build (the reason v0.4.0 shipped no macOS binaries).

## [0.3.5](https://github.com/YIHSUAN603/Helm/releases/tag/v0.3.5) - 2026-07-08

### Fixed

- **Full-screen terminal apps now render on macOS.** Programs that use the terminal's alternate screen — Neovim/Vim, lazygit, htop, and similar — previously opened as a blank, unresponsive pane on macOS while working fine on Windows. They now render and respond correctly.

### Internal

- Moved to the WKWebView-proven rendering stack: `@xterm/xterm` 6.x → 5.5.0 with the canvas renderer (the built-in DOM renderer as fallback). This replaces the earlier one-off WKWebView repaint workarounds, which never reliably painted the alternate screen on xterm 6.x.

## [0.3.3](https://github.com/YIHSUAN603/Helm/releases/tag/v0.3.3) - 2026-07-08

### Fixed

- Full-screen terminal UIs like **nvim** (and other alternate-screen TUIs such as `less`, `htop`, `git rebase`) rendered as a blank pane and looked like they failed to launch. The `@xterm/addon-webgl` renderer was painting the alternate-screen buffer blank on macOS WKWebView — the program was running fine, it just wasn't visible. Helm now uses xterm's built-in DOM renderer. *(Trade-off: GPU-accelerated rendering is disabled; the canvas addon isn't yet published for xterm 6.x.)* (ed9f24d)

### Internal

- Dropped the stale `@xterm/addon-webgl` reference from the Vite manual-chunk config, which was breaking the production build after the addon was removed. (2792863)

## [0.3.2](https://github.com/YIHSUAN603/Helm/releases/tag/v0.3.2) - 2026-07-08

### Fixed

- Agent status no longer sticks on a stale tool/error icon after exit — a composer-idle check marks it done, and closing a pane clears leftover approval/state (e0ed3c4)
- Tab focus is now trapped inside the Settings and Command Palette dialogs (0e20ee6)
- Font size input clamped to its 8–32 range (867aeca)
- Scan state clears on session close; desktop notifications now fire for pending approvals in unfocused workspaces even while the window is focused (56d38f7)
- PTY child processes are reaped and sessions removed on shell exit, fixing zombie processes and leaked file descriptors (788bd26)
- Ctrl+/ now sends `0x1F` so nvim/LazyVim's `<C-/>` binding works (8c2d47e)

### Security

- Content-Security-Policy enabled for the webview, locking down script/connect origins in production (747e3b4)

### Performance

- PTY writes no longer block the global session-map lock, so a stalled write in one session can't stall others (448fc7f)
- Stream extraction capped at the trailing 200 lines per PTY chunk, preventing main-thread stalls during output floods (fcd27fa)
- PTY chunks are decoded only when a session streams to an agent extractor (83060cb)
- Sidebar rows are projected to their visible fields, so cost/token ticks no longer re-render the whole tree (2f556c4)
- Detection regexes and the command list are cached, and store subscriptions narrowed (b1c0cdc)

### Internal

- Added an ESLint flat config with lint/typecheck scripts and a CI step (6ab17a5)
- Filled in Cargo package metadata and relaxed the `fontdb` version pin (bdf7f4f)
- Added coverage for agent registry detection, scan state, list navigation, and i18n key parity (2b5235c)

## [0.3.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.3.1) - 2026-07-08

_v0.3.1_

### Changed

- Sidebar now visually clusters sessions that belong to the same split group into a contiguous block (with a connector bracket and shared tint), instead of scattering them among other sessions. Session cycling (Cmd+1..9, next/prev) follows this same order.
- Update checks no longer auto-download and relaunch on startup — you'll now see a banner (and a matching option in Settings) to review and consent before installing an update.
- The font picker in Settings is now populated with your system's actual installed monospace fonts, falling back to built-in presets if none are found; "Custom…" is still available for manual entry.
- Resolved a clippy lint (`unnecessary_sort_by`) in the font-scanning code that was breaking CI.

## [0.3.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.3.0) - 2026-07-08

_v0.3.0_

### Added

- Split layout replaced the global view mode with **per-group split trees** (tmux window/pane-style).
- Agents now **classify prompt kinds** and extract cost/token usage from the visible viewport.
- Settings: font family is now a **preset picker** instead of a free-text input.

### Fixed

- Hidden panes release their WebGL contexts and recover from context loss.

### Removed

- Direct `Ctrl/⌘` keybindings are **replaced by a `Ctrl+A` prefix system**: press `Ctrl+A`, then a second key (e.g. `%` split right, `"` split down, `c` new session, `1`–`9` switch, `y`/`N` approve/reject).
- A **which-key hint panel** appears while the prefix is armed, listing every available key and dimming disabled ones.
- `Esc`, a 3-second timeout, or window blur cancels the prefix; unknown second keys are swallowed rather than typed into the terminal.
- `Ctrl+A a` (or `Ctrl+A Ctrl+A`) sends a literal `Ctrl+A` through to the shell (beginning-of-line).
- `⌘⇧P` (Command Palette) remains the only direct, non-prefix shortcut.

### Performance

- **PTY output** now streams raw bytes over an invoke `Channel` instead of base64-encoded events — lower latency and no per-chunk encode/decode overhead.
- **Command palette and settings dialog** are lazy-loaded.
- **UI re-renders** are isolated via memoized panes and cached derived values.
- **Agent scanning** relaxed for hidden panes, with pre-filtered extractor regexes.
- **Session store** skips no-op updates and redundant ANSI stripping.

### Internal

- Added a release profile and vite build targets; dropped the unused JS opener dependency.

## [0.2.0](https://github.com/YIHSUAN603/Helm/releases/tag/v0.2.0) - 2026-07-07

_See the assets below to download and install this versioHelm v0.2.0_

### Fixed

- Renamed the app from aiterminal to Helm everywhere — window title, app identifier, installer name, and default shell env var (AITERMINAL_SHELL → HELM_SHELL). ⚠️ Upgrade note This release changes the app's bundle identifier (com.arieschao.aiterminal → com.arieschao.helm). Because of that:
- If you're upgrading from v0.1.x, this will install as a separate app rather than an in-place update — please uninstall the old "aiterminal" build after switching.
- Your saved preferences (theme, language, font, default shell/cwd) will reset to defaults, since they're stored under the new app identity.
- If you use a custom agents.json, you'll need to re-create it under the new config location (or copy it over). No functional/feature changes in this release — it's a housekeeping rename to match the project's actual name, Helm.n.

## [0.1.1](https://github.com/YIHSUAN603/Helm/releases/tag/v0.1.1) - 2026-07-06

_First working release_

> Released under the project's former name, `aiterminal`.

### Added

- Agent awareness — detects when an agent is thinking, running a tool, waiting for approval, done, or stuck, and pops up an approval prompt automatically (Ctrl/⌘+Shift+Y / Ctrl/⌘+Shift+N)
- tmux-style split view — split panes, keyboard-driven layout control
- Workspace-grouped sidebar — sessions organized into collapsible workspaces; approvals, cost, and changed files are scoped to the focused workspace
- Settings — theme presets, font, cursor, default shell/cwd
- Language support — UI strings externalized for i18n
- Auto-update — checks for and installs updates automatically on launch

### Fixed

- Fixed the release build failing during updater artifact signing (rotated the signing key)

---

`v0.1.0`, `v0.4.0` and `v0.9.0` are tagged in the repository but were never published as GitHub Releases, so they have no notes to summarise here. `v0.15.4` was built as a draft and never published. The `v0.8.0` release object lost its tag association upstream, so its heading links to that release's own ref rather than to `/releases/tag/v0.8.0`.
