# Releasing

Releases are built by `.github/workflows/release.yml`: pushing a `v*` tag
packages the app for Windows (NSIS `.exe`), macOS (.dmg, arm64 + x64), and
Linux (.deb/.AppImage/.rpm), and publishes them as a **draft** GitHub Release.

Windows intentionally publishes only the NSIS installer. The Explorer "Open
with Helm" entries are installed and removed by
`src-tauri/nsis/shell-integration.nsh`; an MSI build does not run those hooks
and must not be offered as an equivalent download.

## Checklist

1. Bump the version in all three places, keeping them identical:
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
2. Refresh lockfiles:
   - `npm install` (updates `package-lock.json`)
   - `cargo check` inside `src-tauri/` (updates `Cargo.lock`)
3. Commit and push, e.g. `git commit -am "chore: release v0.2.0"`, then wait
   for CI to go green.
4. Tag and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. When the Release workflow finishes (~15–25 min; macOS jobs are slowest),
   review the draft release on GitHub, edit the notes, and publish.
6. Publishing fires `release: published`, which runs
   `.github/workflows/update-homebrew-cask.yml`: it downloads both macOS dmgs,
   computes their SHA-256, and pushes `chore: update helm-terminal cask to
   X.Y.Z` to [`YIHSUAN603/homebrew-tap`](https://github.com/YIHSUAN603/homebrew-tap)
   (~1 min). Confirm it:

   ```bash
   gh run list --workflow=update-homebrew-cask.yml --limit 1
   brew update && brew info --cask helm-terminal
   ```

   If the run failed or never fired, re-run it against the tag:
   `gh workflow run update-homebrew-cask.yml -f tag=vX.Y.Z`.

## Notes

- **Publishing the release is the single event that makes the download URLs and
  the Homebrew cask real.** Draft assets 404 for everyone but the repo owner,
  the updater endpoint (`releases/latest/download/latest.json`) only sees
  published releases, and the cask's `livecheck` reads `/releases/latest`, which
  ignores drafts. The abandoned `v0.15.4` draft is the cautionary case: assets
  exist, nobody can use them.
- **Do not set `releaseDraft: false` in `release.yml`.** Releases published by
  `GITHUB_TOKEN` do not trigger further workflows, so the cask bump would
  silently stop. Publishing by hand (`gh release edit … --draft=false`, with
  your own token) is what makes the trigger fire.
- `update-homebrew-cask.yml` must be on `main` to run at all — GitHub only runs
  `release`-event workflows from the default branch. The flow above merges before
  tagging, so this is satisfied naturally.
- The bump job pushes to the tap with the `TAP_GITHUB_TOKEN` secret (a
  fine-grained PAT with **Contents: read and write** on `homebrew-tap` only —
  `GITHUB_TOKEN` cannot write to another repository). When that PAT expires the
  job fails with a 403 on `git push`, i.e. a silently stale cask.
- Artifacts are **unsigned**: macOS builds are not notarized and Windows
  installers will show a SmartScreen warning. The Homebrew cask works around the
  macOS half by clearing the quarantine flag in `postflight` (Homebrew 6 removed
  the `--no-quarantine` install flag); users who install the `.dmg` directly need
  `xattr -cr /Applications/Helm.app`.
- Proper macOS code signing, when there is an Apple Developer account ($99/yr)
  with a *Developer ID Application* certificate:
  - `src-tauri/tauri.conf.json`: remove `bundle.macOS.signingIdentity: "-"`.
    `hardenedRuntime` already defaults to `true` in Tauri 2, and no entitlements
    file is needed (PTY fork/exec and the loopback hook server are both allowed
    under hardened runtime; the webview's JIT lives in Apple-signed helper
    processes).
  - `release.yml`: add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
    `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`
    to the existing `tauri-action` `env:` — harmless on the Linux and Windows
    legs. `tauri-action` imports the certificate into a temporary keychain and
    notarizes + staples when all three notarization values are set.
  - Then drop the `postflight` stanza from the cask template.
- Draft releases are invisible to the public, so a test tag is safe to push;
  delete the draft and the tag afterwards
  (`git push origin :refs/tags/v0.1.0`).
- Future options (not needed yet): a `scripts/bump-version.mjs` to rewrite all
  three versions at once, or release-please/changesets for automated bumps.
