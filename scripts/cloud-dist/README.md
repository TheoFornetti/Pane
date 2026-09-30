# cloud-dist

Builds and publishes the Runpane Cloud fork artifacts and the boat golden image. Nothing here publishes
upstream: releases go to the fork (`FORK_REPO`, default `jamari-morrison/Pane`) as **prereleases**, and
the scripts refuse a `greenfield-inc/*` repo.

| Script | Runs on | Does |
|---|---|---|
| `build-artifacts.sh [out]` | build host (boat devbox), repo root | frontend + main build, `electron-builder --linux deb --x64`, `npm pack` of `packages/runpane`, `SHA256SUMS.txt`, `build-info.json` |
| `publish-release.sh --devbox <id> --ref <branch>` | operator (agentbox) | runs the build on the devbox, downloads the files (in 45 MiB parts: boat `GET /artifacts` caps at 50 MiB), verifies sha256, `gh release create rc-<sha8> --prerelease`, checks anonymous download, updates `dist-current.md` |
| `make-golden.sh --tag rc-<sha8>` | operator | sandbox → `golden/provision.sh` → `golden/scrub.sh` → `rp-golden-check golden` → named snapshot `rp-loop-golden-<sha8>` → destroys the source → forks a gate sandbox from the snapshot → `golden/gate-fork.sh` → destroys the gate |
| `release.sh --devbox <id> --ref <branch>` | operator | both of the above, then prunes older `rp-loop-golden-*` snapshots (keeps `KEEP_GOLDENS`, default 2) |

## Versions

Builds are labelled `<package.json version>-rc.<commit UTC YYYYMMDDHHMMSS>.g<sha8>` through
`electron-builder -c.extraMetadata.version`, so `package.json` is never edited and `pane --version` names the
commit. The timestamp makes versions sort by commit time under semver and dpkg, so installing a newer fork
`.deb` with apt is an upgrade. Fork versions sort below the upstream release with the same base version.

## Golden image

- The fork `.deb` only. It is not paired: no `~/.pane_remote`, no analytics id, no service unit.
- Tailscale installed, not joined.
- Playwright Chromium in `/opt/ms-playwright`, with `PLAYWRIGHT_BROWSERS_PATH` set in `/etc/environment`.
  Boat snapshots drop `~/.cache` and `/tmp`, and a directory `mv`'d in from those paths arrives empty.
- `rp-firstboot-identity` and `rp-golden-check` in `/usr/local/sbin`, and `/etc/rp-golden.json`.
  Forks are restored onto machines that are already running and don't reboot, so per-sandbox provisioning
  must run `sudo /usr/local/sbin/rp-firstboot-identity` itself before joining Tailscale.

The gate on the fork checks four things:

1. The identity strip list (fork mode).
2. `pane --version` equals the release version.
3. A headless daemon from `/opt/Pane/pane` answers `/health` on loopback.
4. Chromium takes a screenshot.

## Environment

`BOAT_HDR` (curl header file holding the boat `Authorization` header), `RC_BIN` (the rc-loop helpers
`devbox.sh`, `sb-create.sh`, `sb-destroy.sh`, `boat.sh`), `FORK_REPO`, `DIST_CURRENT`, `EVIDENCE_DIR`.
Defaults point at `~/rc-loop`. Create a devbox with `~/rc-loop/bin/devbox.sh create <name>`.
The devbox checks out `origin/<ref>`, so push the branch first.
