# Helm

A terminal that watches your AI coding agents for you.

## What Helm does

Helm is a desktop terminal app. Each tab is a real shell session — but when
you run an AI coding agent like Claude Code or Codex in one, Helm watches
its output and tells you what it's doing: thinking, running a tool, waiting
for your approval, done, or stuck on an error. Pending approvals, running
cost, and files an agent has changed are all surfaced in one place, so you
can run several agents side by side without babysitting each terminal
individually.

## Installing

Download the installer for your platform from the
[GitHub Releases page](https://github.com/YIHSUAN603/Helm/releases). Helm
checks for updates automatically every time it starts and lets you know when
a new version is available — you choose when to install it, either from the
prompt in the toolbar or from **Settings → About**.

Prefer to build it yourself? See [Building from source](#building-from-source)
below.

## Getting started

1. Helm opens with one empty session ready to go.
2. Click **+** next to a workspace to start a new session, and choose what
   to launch: **Claude Code**, **Codex**, **Shell** (a plain terminal, no
   agent detection), or any custom agent you've added.
3. Use it like a normal terminal — everything you type goes straight to the
   real shell.
4. When the agent needs your input, Helm shows an **approval prompt**
   automatically with **Approve**/**Reject** buttons (or the shortcuts
   `Ctrl+A y` / `Ctrl+A N`) — no need to switch to that tab and read its
   output yourself.

## Organizing sessions

The sidebar has two levels: **workspaces** (groups) containing **sessions**
(individual terminals).

- **New workspace** — click **+** in the sidebar header; it's ready for you
  to name right away.
- **Rename a workspace** — double-click its header, or select it and press
  `F2`.
- **Delete a workspace** — hover its header and click the **×**; this also
  closes every session in it. The default workspace can't be deleted.
- **Collapse/expand** — click the header or its chevron.
- **Set a default folder** — hover the workspace and click **📁** to pick a
  folder; new sessions started in that workspace open there. The chosen path
  is shown under the header — hover it and click **×** to clear. A workspace
  without a folder falls back to the default working directory in Settings.
- **New session in a workspace** — hover the workspace and click its **+**.
- **Move a session** — drag it onto another workspace (even a collapsed
  one) to drop it there.
- **Rename a session** — double-click it, or select it and press `F2` or
  `r` (`Ctrl+A r` works from anywhere). Handy when three tabs are all
  running `claude`. Clear the name to go back to the automatic one the
  agent sets.
- **Close a session** — click its **×**, or select it and press
  `Delete`/`Backspace`.

Each session shows a status dot (thinking, running, awaiting approval, done,
error — or idle/running/exited for a plain shell) plus an agent badge if
one is running. A workspace you're not currently viewing shows a badge with
its pending-approval count — click it to jump straight to that approval.

Your workspaces — their names, folders, and collapsed state — are remembered
between launches. Sessions are not: every launch starts with one fresh
session. If a workspace's folder isn't reachable (an external drive that
isn't mounted, a project you moved), its path is shown struck through and
new sessions there start in your home directory instead.

## Split groups

Each session controls its own layout. A session normally fills the whole
screen; splitting it creates a new session next to it and the two form a
**split group** — switching to any member of the group shows the whole
group's layout, while sessions outside it still show fullscreen. When a
group is down to one pane it dissolves and that session goes back to
fullscreen.

- **Split a pane** — use the ◫ (split right) / ⊟ (split down) buttons on a
  pane's title bar, or `Ctrl+A %` (right) and `Ctrl+A "` (down), just like
  tmux. Right-click a split button (or use the Command Palette) to choose
  which agent to launch in the new pane instead of a plain shell.
- **Close a pane** — the **×** on its title bar, or `Ctrl+A x`.
- **Resize** — drag the divider between panes (double-click a divider to
  reset it to 50/50), or `Ctrl+A Ctrl+arrow` to resize the focused pane in
  small steps.
- **Move focus between panes** — `Ctrl+A arrow`, or `Ctrl+A o` to cycle to
  the next one.

## Keeping track of your agents

- **Approval panel** — pops up automatically whenever an agent in your
  current workspace is waiting on you. Shows the agent, the session, and
  its actual question, with Approve/Reject per session and Approve
  All/Reject All when more than one is waiting. If the same prompt keeps
  reappearing after you respond, Helm will tell you the automated
  keystrokes may not match that agent — reply directly in the terminal
  instead.
- **Cost and tokens** — the toolbar shows the active session's running cost
  and input/output token counts, plus a workspace-wide total (Σ).
- **Changed files** — click the toolbar's file-count button (or
  `Ctrl+A f`) to see every file an agent has touched in the current
  workspace, grouped by session. **Click any file to see its diff** — what
  changed against the last commit, right inside Helm, so reviewing an
  agent's work doesn't mean switching to another tool. Use `[` and `]` to
  step through the files, and `Esc` to close. It's strictly read-only:
  Helm never stages, commits, or edits anything.

## Agent integrations (optional, recommended)

Out of the box Helm detects an agent's state by reading what's on screen,
which can lag or misread when an agent's UI changes between versions.
Claude Code and Codex also provide official channels, and Helm can use
them for instant, precise detection:

- **Claude Code hooks** — open Settings → **Agent integrations** and click
  **Install**. This adds a small forwarding hook to
  `~/.claude/settings.json`, so Claude Code itself tells Helm the moment it
  needs approval (including the exact command or file), when a turn ends,
  and which files changed. Outside Helm the hook does nothing.
- **Claude Code statusline** — a separate opt-in install that also reports
  live cost and remaining context. If you already have a custom statusline,
  Helm won't touch it.
- **Codex notifications** — Codex can emit desktop-notification escape
  codes that Helm reads directly. Copy the two-line snippet shown in
  Settings into the `[tui]` section of `~/.codex/config.toml`.

Screen reading stays on as a fallback, so everything keeps working if you
skip this — approvals just take a moment longer to detect.

## Command Palette

Press `Ctrl/⌘+Shift+P` to open a searchable list of everything Helm can do
— split panes, start a session with a specific agent, toggle the theme,
approve/reject, open Settings, jump to a session, and more — each shown
with its keyboard shortcut. Type to filter, arrow keys plus Enter to run.

## Keyboard shortcuts

Helm uses **tmux-style prefix shortcuts**: press `Ctrl+A` (the prefix —
literally Ctrl, on every platform including macOS), then a second key. While
the prefix is active a hint panel lists every available key; press `Esc`
(or wait a moment) to cancel. An unknown second key is swallowed, never
typed into the terminal.

Because the shell itself uses Ctrl+A for "beginning of line", press
`Ctrl+A a` (or `Ctrl+A Ctrl+A`) to send a literal Ctrl+A through to the
terminal.

The same reference is available in the app at any time with `Ctrl+A ?` (or the
`?` button at the bottom of the sidebar). Both it and the tables below are
generated from the key tables in the source, so they cannot fall out of date.

<!-- shortcuts:start -->
<!-- Generated by scripts/gen-shortcut-docs.ts — edit the key tables, not this block. -->

### Global (Ctrl+A prefix)

Press Ctrl+A, then the second key. Esc or 3 seconds cancels; an unrecognised second key is swallowed and never reaches the terminal. Ctrl+A in a text field stays select-all.

| Key | Action |
| --- | --- |
| `%` | Split Right |
| `"` | Split Down |
| `x` | Close Pane |
| `o` | Focus: Next Pane |
| `← · → · ↑ · ↓` | Focus the pane in that direction |
| `Ctrl+←` | Shrink Pane |
| `Ctrl+→` | Widen Pane |
| `Ctrl+↑` | Shorten Pane |
| `Ctrl+↓` | Heighten Pane |
| `c` | New Session (shell) |
| `n` | Next Session |
| `p` | Previous Session |
| `r` | Rename Session |
| `1…9` | Switch to Session 1–9 |
| `g` | Focus Sidebar |
| `w` | New Workspace |
| `f` | Changed Files Panel |
| `e` | Toggle Sidebar |
| `b` | Notifications |
| `h` | Collapse Approval Panel |
| `t` | Toggle Theme |
| `s` | Open Settings |
| `y` | Approve Current Session |
| `N` | Reject Current Session |
| `Ctrl+y` | Approve All (This Workspace) |
| `Ctrl+n` | Reject All (This Workspace) |
| `Tab` | Cycle Focus Region |
| `Shift+Tab` | Cycle Focus Region (Backward) |
| `i` | Back to Terminal |
| `/` | Find in Terminal |
| `?` | Keyboard Shortcuts |
| `a` | Send Ctrl+A to Terminal |

### Direct shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command Palette |

### Sidebar (focused row)

Bare keys only — held Ctrl / Alt / Cmd is left to the global layer and the OS.

| Key | Action |
| --- | --- |
| `j · k · ↑ · ↓ · g · G` | Move focus through the tree |
| `r · F2` | Rename |
| `c` | New session in this workspace |
| `w` | New workspace |
| `f` | Set this workspace's folder |
| `Delete · Backspace · x` | Close session / delete workspace (asks first) |
| `Esc` | Back to the terminal |
| `Enter · Space` | Activate session |
| `Enter · Space` | Collapse or expand workspace |
| `h · ←` | Focus the parent workspace |
| `h · ←` | Collapse workspace |
| `l · →` | Expand workspace, or enter it |

### Panels and overlays

| Key | Action |
| --- | --- |
| `Esc` | Close the panel or overlay, restoring focus |
| `Tab · Shift+Tab` | Move within a dialog (focus stays inside) |
| `Enter · Space` | Activate the focused row |
| `j · k · ↑ · ↓ · g · G` | Move through a list or menu |
| `[ · ]` | Previous / next changed file in the diff view |
| `Tab · ← → ↑ ↓ · Enter` | Focus a split divider, resize it, Enter resets to 50/50 |
| `ContextMenu · Shift+F10` | Open the launcher menu on a pane's split button |
| `Enter · Esc` | Confirm / cancel a pending confirmation |

### Terminal

| Key | Action |
| --- | --- |
| `Ctrl+/` | Sends 0x1F, so <C-/> works in nvim and friends |
| `Ctrl+C` | Copies when there is a selection, otherwise interrupts |
| `Ctrl+A` | Arms the prefix; in a text field it stays select-all |

<!-- shortcuts:end -->

## Settings

Open Settings from the gear icon at the bottom of the sidebar. Everything
here applies immediately and is remembered for next time:

- **Theme** — 10 presets (Dark, Light, Solarized Dark, Nord, Dracula,
  Gruvbox Dark, One Dark, Tokyo Night, GitHub Dark, GitHub Light)
- **Language** — English or Traditional Chinese (繁體中文)
- **Font family** and **font size** (8–32)
- **Cursor style** (block, bar, underline) and **cursor blink**
- **Default shell** and **default working directory** for new sessions
  (leave blank to use your system's defaults)
- **Agent integrations** — one-click setup for the official Claude Code /
  Codex signals (see [Agent integrations](#agent-integrations-optional-recommended))
- Installed app version and current update status

## Supported agents & customization

Helm recognizes **Claude Code** and **Codex** out of the box. To add
support for another CLI agent (or customize how approvals are detected),
create or edit an `agents.json` file in Helm's config directory — no code
required, just describes how to recognize the tool and its states.

## Building from source

Prefer to run Helm from source, or contribute to it?

**Prerequisites:** [Node.js](https://nodejs.org/) >= 22.6 (see `.nvmrc`),
[Rust](https://www.rust-lang.org/tools/install) (stable), and Tauri's
platform dependencies (see the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)).

```bash
npm install
npm run tauri dev     # run the app
npm run tauri build   # package an installer
```

See [`CLAUDE.md`](./CLAUDE.md) for the codebase architecture and
[`docs/RELEASING.md`](./docs/RELEASING.md) for the release process.

## License

MIT — see [`LICENSE`](./LICENSE).
