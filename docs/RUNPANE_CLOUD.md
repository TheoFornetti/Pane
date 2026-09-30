# Runpane Cloud quickstart

Runpane Cloud runs a Pane Session on its own cloud sandbox (boat.dev), with a normal Pane daemon inside,
joined to your tailnet and saved as a remote host in your Pane apps. The Session keeps running when your
laptop is closed, and you can put it to sleep (no compute billing) and wake it in about 12 seconds.

Everything here is the `runpane cloud` command on your own machine. The desktop app stays a remote
client: it lists cloud Sessions next to your other remote hosts and never creates or manages machines.

- How a sandbox is set up: [RUNPANE_CLOUD_BOOTSTRAP.md](RUNPANE_CLOUD_BOOTSTRAP.md)
- The always-on coordinator (idle-stop, wake for peers): [RUNPANE_CLOUD_COORDINATOR.md](RUNPANE_CLOUD_COORDINATOR.md)
- Daemon surface (`/health`, safe-to-stop, version pin): [RUNPANE_CLOUD_DAEMON.md](RUNPANE_CLOUD_DAEMON.md)
- Remote hosts, `--host`, peers and the phone app in general: [SELF_HOSTED_REMOTE_DAEMON.md](SELF_HOSTED_REMOTE_DAEMON.md)

## What you need

- **A boat.dev API key** (`BOAT_DEV_API_KEY`) on a paid plan with a payment method. `runpane cloud`
  creates sandboxes without a provider time limit, which boat allows only with auto-pay on.
- **A Tailscale OAuth client** with the `auth_keys` scope for `tag:rp-session`: its client id and its
  secret (`TAILSCALE_OAUTH_SECRET`). Your tailnet policy must define `tag:rp-session`. Recommended grants
  (see [Tailnet policy](#tailnet-policy)): Sessions reach each other on tcp/443 only, plus the coordinator's
  tcp/47300.
- **Tailscale on every device that uses a cloud Session**: the laptop that runs `runpane`, and your phone
  if you use the phone app. Cloud Sessions are reachable only over the tailnet.
- **Node.js 20+ and npm** on the laptop.
- Optional: an Anthropic API key for agents in cloud Sessions (see [Agents in a cloud Session](#agents-in-a-cloud-session)).

## 1. Install the CLI

Runpane Cloud is not in the npm release of `runpane` yet. Install the build from the fork's prereleases
(https://github.com/jamari-morrison/Pane/releases). Take the newest `rc-*` release whose notes say
`branch rc/integration` (others are test builds of work branches); its notes carry the exact install line:

```bash
gh release list -R jamari-morrison/Pane --limit 5      # newest first
gh release view rc-<sha> -R jamari-morrison/Pane       # check "branch rc/integration", copy the npm line
npm i -g https://github.com/jamari-morrison/Pane/releases/download/rc-<sha>/runpane-<version>.tgz
runpane version          # 2.4.141-rc.<date>.g<commit>
runpane cloud --help     # lists setup, new, list, status, stop, wake, destroy, pair, sync, coordinator
```

Run `runpane cloud` from a normal terminal, not from a terminal inside Pane desktop. Pane puts its own
bundled `runpane` first on `PATH` in its terminals, and that build has no `cloud` command. From inside
Pane, call the global one by path: `"$(npm prefix -g)/bin/runpane" cloud ...`.

To go back to the npm release: `npm i -g runpane@latest`. Your cloud state in `~/.config/runpane-cloud`
is kept.

## 2. Set up your keys (once)

`runpane cloud setup` stores the keys on this machine only (`~/.config/runpane-cloud/credentials.json`,
mode 0600) and checks each one live. It takes secrets only as files or stdin (`-`), never as
command-line values, and it never prints them. Leading and trailing whitespace is trimmed, so values with
a trailing newline are fine.

With the keys in Doppler (project `montlake`, config `dev_personal`), process substitution passes each
one as a file without writing it to disk or showing it:

```bash
D="doppler secrets get --project montlake --config dev_personal --plain"
runpane cloud setup \
  --boat-key-file <($D BOAT_DEV_API_KEY) \
  --tailscale-client-id krreHuCr3M11CNTRL \
  --tailscale-secret-file <($D TAILSCALE_OAUTH_SECRET) \
  --claude-token-file <($D <Claude token secret name>) \
  --golden <golden snapshot name> \
  --name-prefix rp-red \
  --size large
```

- Agent sign-in for cloud Sessions (see [Agents in a cloud Session](#agents-in-a-cloud-session)):
  `--claude-token-file` takes a Claude subscription token (from `claude setup-token`);
  `--anthropic-key-file <($D ANTHROPIC_API_KEY)` takes an Anthropic API key instead. Both are optional.
- `--name-prefix` names your sandboxes and tailnet hosts `<prefix>-<id>` (default `rp`). The coordinator
  manages every sandbox whose name starts with `<prefix>-`, so pick a prefix no other sandboxes in the
  boat account use: the build loop's boxes are all `rp-loop-*`, which `rp-` would match.
- `--golden` names the image new Sessions start from: a boat named snapshot with the Pane daemon, Tailscale
  and Playwright's Chromium preinstalled. It makes `new` about a minute faster. Without it (`--no-golden`)
  each `new` installs everything onto the plain image. Fork builds make goldens named
  `rp-loop-golden-<sha8>` in the boat account (`scripts/cloud-dist/make-golden.sh`; list them in boat's
  console under snapshots). Releases keep only the newest two, so point `setup --golden` at a recent one.
- `--size` sets the default machine size; see [Costs](#costs). The built-in default is `default`
  (4 vCPU / 8 GB); `large` (8 vCPU / 16 GB) is the one to use for more than one agent with browser tests.
- Rerun `setup` with any subset of flags to change one setting. The others are kept.

Setup prints what is configured. `runpane cloud list` works after setup and shows `0` hosts.

## 3. Create a cloud Session

```bash
runpane cloud new --label "api work" --repo https://github.com/<you>/<repo>.git --yes
```

This takes about a minute (boat create ~1 s, running in ~4 s, then tailnet join, daemon install and the
first TLS certificate). It:

1. creates a sandbox named `rp-<8 chars>` (the same name is its tailnet host name; `setup --name-prefix`
   changes `rp`);
2. turns on a host firewall that lets only tcp/443 (Tailscale Serve) in over the tailnet, then joins your
   tailnet as `tag:rp-session`, with a single-use key and Tailscale SSH off;
3. starts the Pane daemon, reachable at `https://rp-<id>.<your-tailnet>.ts.net`;
4. clones `--repo` (public HTTPS repositories only; add `--ref <branch>` for a branch) into
   `/home/user/<repo>` and registers it with the Session's Pane, so `runpane --host <Session> panes create
   --repo <repo>` works right away;
5. saves the host in `~/.config/runpane-cloud/hosts/` and the pairing code in
   `~/.config/runpane-cloud/hosts/<host>.pairing` (0600, never printed);
6. adds the host to Pane desktop's saved remote hosts, if `~/.pane/config.json` exists.

`--yes` is required because the sandbox costs money. `--size large` overrides the default size for one
Session. If setup fails part-way, `new` deletes the tailnet device and the sandbox again; add
`--keep-on-failure` to keep them for debugging.

```bash
runpane cloud list                 # every cloud Session with its state
runpane cloud status "api work"    # awake | asleep | waking | stopping | daemon-down | lost
```

A cloud Session can be named by its host name (`rp-...`), cloud Session id, label or sandbox id
everywhere below.

## 4. Use it

### Pane desktop

`new` already added the host. In Pane desktop, open the remote host switcher in the sidebar and pick it:
you get an ordinary remote Pane (agent panels, terminals, diffs). One remote host is active at a time.

> **Released (upstream) Pane desktop builds: quit the app first.** `new`, `sync` and `destroy` edit the
> desktop's saved remote hosts on disk (`~/.pane/config.json`). A released desktop that is running doesn't
> notice that edit, so the host doesn't show up. Worse, the app's next settings save (any toggle) writes its
> old copy back and **erases the hosts `runpane cloud` added** (`remoteDaemon.client.profiles` becomes empty).
> Until your desktop has the fix:
>
> 1. Quit Pane desktop completely (on macOS: Pane > Quit, not just closing the window).
> 2. Run `runpane cloud new`, `sync` or `destroy`.
> 3. Reopen Pane desktop and check that the host is listed in the switcher. If it isn't, quit again and run
>    `runpane cloud sync`.
>
> Or leave the desktop running and import through the app itself, which is safe: `runpane cloud new
> --no-import ...`, then `runpane cloud pair <host>` and paste the code into `Settings > Remote Pane >
> Import Remote Connection`.
>
> The fix (commit `cd190659`: the desktop now picks up outside edits live and never writes over them) is in
> fork builds from `rc/integration` at `080d3828` or later. Those builds ship the desktop as a **Linux `.deb`
> only**, so macOS and Windows desktops need the workaround until an upstream release has it. A fork `.deb`
> desktop shows a "Software Update" prompt for the upstream release on launch. Dismiss it: updating would
> replace the fork build.

If Pane desktop was not installed yet, or you use another data directory, add every cloud Session later
with:

```bash
runpane cloud sync                           # into ~/.pane
runpane cloud sync --desktop-dir <pane dir>  # somewhere else
```

For a desktop on another machine, print the pairing code and paste it into `Settings > Remote Pane >
Import Remote Connection` there:

```bash
runpane cloud pair "api work"     # prints the pane-remote:// code; treat it like a password
```

### Phone

1. Install Tailscale on the phone and sign in to the same tailnet.
2. Open https://runpane.com/app/ (on iPhone: Safari, Share, Add to Home Screen).
3. Paste the code from `runpane cloud pair <host>`.

The phone app needs the Session on HTTPS: it can't open an `http://` Session (see
[HTTPS certificates and `--transport`](#https-certificates-and---transport)).

### From the CLI

Every daemon command takes `--host <cloud Session>`:

```bash
runpane --host "api work" repos list --json
runpane --host "api work" panels list
runpane --host "api work" panels submit --panel <panel id> --text "npm test" --yes
```

### Agents in a cloud Session

Agents run inside the sandbox, so they need their own sign-in there. Save one with `runpane cloud setup`:
`--anthropic-key-file <file|->` (an Anthropic API key) or `--claude-token-file <file|->` (a Claude
subscription token from `claude setup-token`). Every later `new` writes it into the sandbox as a 0600
environment file for the Pane daemon (never on a command line) and pre-answers Claude Code's first-run
prompts, so a Claude panel works right away. Without either, open a terminal in the cloud Session and run
`claude` once to log in; that sign-in lives on the sandbox disk and survives sleep and wake.

## 5. Sleep and wake

```bash
runpane cloud stop "api work" --yes   # flushes the disk, then stops: compute billing stops, disk kept
runpane cloud wake "api work"         # resumes and returns once the daemon answers /health
```

- A stopped Session keeps its disk (repositories, worktrees, Pane's database, agent transcripts), its
  tailnet name and its pairing. Wake takes about 10 to 13 seconds to `/health`.
- After a wake, panels come back: submitting to a panel restarts it if needed, and a Claude panel resumes
  the same conversation.
- boat's stop is a hard power-off after a live snapshot, with no shutdown signal. So `stop` first asks
  the daemon to flush (it checkpoints Pane's database and syncs the disk; an older daemon just gets
  `sync`). If an agent is still working or a terminal is busy, `stop` warns but stops anyway, because you
  asked. `--force` skips the flush; avoid it.
- `~/.cache`, `/tmp` and `/var/tmp` are not kept across a stop.
- Every wake counts against boat's start limit; see [Costs](#costs).
- `wake --size large` resumes onto a bigger machine (about 11 s); the disk is kept.

While a Session is asleep, Pane desktop can't connect to it. Wake it from the CLI, then pick it again in
the switcher. `runpane --host <asleep Session> ...` fails without waking it: a plain connection error, or
`ERR_RUNPANE_HOST_ASLEEP` when a coordinator is set up. With a coordinator, `panels submit` is the one
command that wakes the Session first (next section).

## 6. The coordinator (idle-stop and wake-on-submit)

The coordinator is a small always-on service on its own boat `small` sandbox in your tailnet. It:

- stops cloud Sessions that are idle: it asks each daemon's safe-to-stop, which refuses while an agent is
  working, a terminal printed output recently, a lock is held, a watcher is active, a PR has pending
  checks, or a desktop or phone client is attached (pending PR checks need a signed-in `gh` in the
  Session; without one that check can't see anything and doesn't block);
- stops (never destroys) managed sandboxes that are not in your directory, and alerts;
- answers `/cloud/wake`, so `runpane --host <asleep Session> panels submit` and peer Sessions can wake a
  sleeping Session;
- holds a scoped boat key (read, stop, resume; creating and deleting stay on your laptop) and, for each
  Session, a coordinator-scoped Pane token that can only ask safe-to-stop and run the pinned upgrade. It
  can't reach panels, shells or the event stream.

<!-- coordinator-deploy:start -->
Deploy it once from the laptop (one boat start; about 20 s):

```bash
runpane cloud coordinator deploy --yes
```

It creates a `small` sandbox named `<name-prefix>-coord` from your golden image, joins it to the tailnet
as `tag:rp-session` (Tailscale SSH off; over the tailnet it accepts only its API port, 47300), mints a
boat key scoped to `sandbox.read`, `sandbox.stop` and `sandbox.resume` (it can't outlive your account
key, so the CLI picks the longest lifetime boat accepts and prints it), installs the service from this
CLI's own package, and writes `~/.config/runpane-cloud/coordinator.json` (your caller token, 0600). From
then on:

- every `runpane cloud new` adds the coordinator's scoped client to the Session and writes the Session's
  peers list (`~/.config/runpane-cloud/peers.json` in the sandbox) naming the coordinator;
- `new`, `destroy` and `sync` push the directory, and `runpane cloud wake` wakes through the coordinator
  (so the pinned version and the idle-stop grace after a wake apply);
- Sessions created before the deploy have no coordinator client, so idle-stop skips them (deploy lists
  them).

It manages sandboxes named `<name-prefix>-*` and nothing else. Its reconciler stops (never deletes)
running sandboxes with that prefix that are not in your directory after 30 minutes, so give your cloud
Sessions a prefix no other tooling uses (`runpane cloud setup --name-prefix ...`).

```bash
runpane cloud coordinator status                # the coordinator itself: sandbox, service, version
runpane cloud coordinator stop --yes            # pause idle-stop and wake-on-submit (billing stops)
runpane cloud coordinator start                 # bring it back (one boat start)
runpane cloud coordinator deploy --yes          # run again to update it in place; no new sandbox
runpane cloud coordinator destroy --yes         # device and sandbox; Sessions untouched (see below for the key)

runpane cloud coordinator status "api work"     # its view of one Session, without waking it
runpane cloud coordinator wake "api work"
runpane cloud coordinator idle-check --dry-run  # what idle-stop would stop now
runpane cloud coordinator reconcile --dry-run
runpane cloud coordinator alerts
```

Deploy options: `--idle-check-seconds <n>` (default 300; a Session is stopped after two safe answers in a
row) and `--wake-grace-seconds <n>` (default 600) are kept across redeploys; `--no-reconcile` turns the
reconciler off; `--pin-version <v> --pin-deb-url <url> --pin-deb-sha256 <hex>` pins the Pane version, and
every Session the coordinator wakes is upgraded to it before it counts as awake (`--no-pin` removes the
pin). While the coordinator is stopped, idle Sessions just stay awake and only `runpane cloud wake` wakes
a sleeping one.

boat only lets its dashboard revoke API keys, so `destroy` can't revoke the coordinator's scoped key: it
prints the key id, and you revoke it under API Keys in boat's dashboard (it also expires on its own).
<!-- coordinator-deploy:end -->

## 7. Let one Session message another (peers)

By default a cloud Session can't reach any other. You can let Session A send messages to Session B's
orchestrator panel, and nothing else: no shells, no terminal output, no event stream. The receiving agent
sees `[peer message from <A's label>] <text>`, at most 10 messages a minute. A trusted peer can still steer
B's orchestrator agent, so allow only Sessions you would let type into it.

<!-- peers:start -->
From the laptop, with both Sessions set up by `runpane cloud new`:

```bash
runpane cloud peers allow <A> <B>      # A may message B's orchestrator; B must be awake
runpane cloud peers list
runpane cloud peers revoke <A> <B>     # B deletes the record: the token stops working at once
```

`allow` mints a peer record on B, allowlisted to one Pane Session on B: the only one you created, or
`--session <name>` when B has several (B needs one; create it in Pane desktop or with
`runpane --host <B> sessions create`). The token goes only into A's peers list in A's sandbox (0600); it is
never printed. The grant is one-way; run `allow B A` too for replies. If A is asleep, the grant is saved
and A's list is written when you next `runpane cloud wake A`.

An agent in Session A then uses B by its host name:

```bash
runpane --host <B> panels list
runpane --host <B> panels submit --panel orchestrator --text "..." --yes
```

With a coordinator, that submit wakes B if it is asleep and delivers once; `panels list` and `watch`
never wake it.
<!-- peers:end -->

## 8. Destroy

```bash
runpane cloud destroy "api work" --yes
```

This deletes the tailnet device first, then the sandbox and its disk, checks both are gone, then removes the
local record and the Pane desktop profile. It can't be undone: push any work to your git remote first.
Destroy costs no boat start.

## Costs

| Size | Machine | Awake | Asleep |
|---|---|---|---|
| `small` | 2 vCPU / 4 GB | $0.018/h | $0 compute, disk kept |
| `default` | 4 vCPU / 8 GB | $0.036/h | $0 compute, disk kept |
| `large` | 8 vCPU / 16 GB | $0.072/h | $0 compute, disk kept |

- Measured with three agents running TypeScript builds and browser tests: `large` handled it; `default` and
  `small` ran out of memory. `default` is fine for one agent. `small` is for the coordinator (about $13 a
  month always on).
- A large Session awake 8 hours a day costs about $0.58 a day.
- Runaway guard: `new` refuses when 25 of your cloud sandboxes are already live. Change it with
  `runpane cloud setup --max-live <n>`.

**boat start limits.** boat counts every sandbox start account-wide: `new` is one start, and every `wake`
(including a coordinator wake) is one start. `stop`, `destroy`, `list` and `status` are free. The limits
are **12 a minute, 60 an hour and 200 a day**. Past them boat answers HTTP 429 and `new`/`wake` exit 1
with boat's message; the CLI does not retry. Wait and run it again.

## HTTPS certificates and `--transport`

Tailscale Serve gets each Session's HTTPS certificate from Let's Encrypt, which issues at most **50
certificates per week for your tailnet's domain** (`<tailnet>.ts.net`). Every new Session host name needs one,
so creating and destroying many Sessions in a week (tests, CI) uses the quota up, and new Sessions then can't
get a certificate. The limit lifts on its own after a few days.

`runpane cloud new --transport` (also a `setup` default):

- `auto` (default): tries HTTPS. If it doesn't answer within about 45 s while the Session's Pane is healthy,
  the Session switches to **plain HTTP inside the tailnet**: Tailscale Serve forwards TCP port 42137 to the
  daemon, and the host's address becomes `http://<host>.<tailnet>.ts.net:42137`. WireGuard still encrypts
  everything end to end; there's just no TLS layer on top.
- `https`: HTTPS only; `new` fails if no certificate comes.
- `http`: plain HTTP inside the tailnet from the start (uses no certificate).

`runpane cloud status <host>` shows which one a Session uses. Pane desktop and `runpane --host` work with both.
**The phone app at https://runpane.com/app can't reach an `http://` Session**: a page loaded over HTTPS
may not call plain HTTP (mixed content). Use Pane desktop or the CLI for such a Session, or create it again
(`--transport https`) once certificates are available.

To avoid the limit: keep long-lived Sessions and let them sleep instead of destroying and recreating them, and
run tests that churn Sessions in a separate tailnet.

## Tailnet policy

`runpane cloud` can't edit your tailnet policy (its OAuth client only mints keys). Each Session therefore
guards itself: an nftables table `inet rp_tailnet` (`/etc/rp-tailnet-firewall.nft`, reloaded at boot by
`rp-tailnet-firewall.service`, so it survives sleep and wake) accepts only replies and tcp/443 on
`tailscale0`. The sandbox provider runs its own services on the machine (a desktop stream on 8090, an agent
service on 8911, sshd), and without the firewall a compromised peer Session could reach them.

Tighten the policy too, so the tailnet enforces the same thing. With grants:

```json
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:rp-session"], "ip": ["tcp:443", "tcp:47300"] },
  { "src": ["tag:rp-session"], "dst": ["tag:rp-session"], "ip": ["tcp:443", "tcp:47300"] }
]
```

`tcp:47300` is only for the coordinator (section 6). Drop it if you don't run one. Keep your own rules
for your other devices.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Unknown command: cloud` | You are running Pane's bundled `runpane` (inside a Pane terminal) or the npm release. Use a normal terminal, or `"$(npm prefix -g)/bin/runpane"`; check `runpane version` shows `-rc.` |
| `new` or `wake` fails with `429` / "60 sandbox starts per hour" | boat's start limit (see [Costs](#costs)). Wait, then rerun. Prefer stopping and waking over creating new Sessions |
| `new` fails at the create step with a boat error about the snapshot | The saved golden image was deleted (releases keep only the newest two). `runpane cloud setup --golden <newer snapshot>`, or `--no-golden` |
| `setup` says a Tailscale key is invalid (401) | Wrong client id or secret, or the OAuth client lacks `auth_keys` for `tag:rp-session` |
| `new` fails at `install-pane` with a dpkg error (`failed to remove my own update file /var/lib/dpkg/updates/...`) | Seen once when a `--pane-deb-url` install ran on a fresh golden fork. `new` has already removed the sandbox and device; run it again. A golden image that already carries the right Pane (`--pane-preinstalled`, the default with `--golden`) skips this step |
| `new` fails at `tailscale-join` or the /health wait | Check the tailnet policy has `tag:rp-session`. `new` has already cleaned up; rerun with `--keep-on-failure` to look inside |
| `new` failed and `runpane cloud list` shows nothing for it | Rarely, boat creates the sandbox but naming it fails, and the CLI loses track of it. Look in boat's console for a sandbox without an `rp-` name created at that time and delete it there |
| A host from `runpane cloud new` or `sync` doesn't show in the desktop switcher, or vanished after you changed a setting | A released desktop was running during the import and then wrote its old config back. Quit Pane desktop, run `runpane cloud sync`, reopen it (see [Pane desktop](#pane-desktop)) |
| The desktop says "Connection failed" for a cloud host | The Session is probably asleep. The host switcher says so for cloud hosts ("Cloud host asleep or unreachable", with a Copy wake command item); run `runpane cloud wake <host>`, then pick it again. If it is awake, check `tailscale status` on the laptop |
| The phone app can't connect | The phone must be on the same tailnet (Tailscale app signed in and connected) |
| After a wake the Session (or the coordinator) doesn't answer; `tailscale status` in the sandbox says "Logged out" | boat sometimes restores a stopped sandbox with an empty Tailscale state file. `runpane cloud wake <host>` (or `runpane cloud coordinator start`) detects it and re-enrols the node under the same name; the pairing keeps working |
| `status` says `daemon-down` | The sandbox runs but the Pane daemon doesn't answer. Wake it again (`stop --yes`, then `wake`), or open the sandbox in boat's console and run `systemctl --user status pane-remote-daemon` |
| `status` says `lost` | The sandbox is gone on boat's side. `runpane cloud destroy <host> --yes` removes the tailnet device and the local record |
| A tailnet host name got a `-1` suffix | A device with that name already existed. `destroy` deletes the device first; if you re-enrol a node by hand, delete the old device in the Tailscale admin console first |
| Files written just before a stop are missing | boat powers off without warning ~4 s after the stop call. Don't use `stop --force`; let `stop` flush |
| A tool cache or `/tmp` file is gone after wake | `~/.cache`, `/tmp` and `/var/tmp` are not kept across a stop. Keep what matters under `/home/user` |
| `runpane --host X ...` fails to connect, or says `ERR_RUNPANE_HOST_ASLEEP` | X is asleep. Only `panels submit` with a coordinator wakes a Session; otherwise run `runpane cloud wake X` |
| A coordinator command says `no coordinator client config at .../coordinator.json` | `~/.config/runpane-cloud/coordinator.json` is missing; see [section 6](#6-the-coordinator-idle-stop-and-wake-on-submit) |
| `new`, `destroy` or `sync` warns "Retry with: runpane cloud sync" | The coordinator was unreachable. The change itself succeeded; run `runpane cloud sync` when it is back |

To check a daemon by hand: `curl https://rp-<id>.<your-tailnet>.ts.net/health` returns its version and
readiness (`readiness.state`: `starting`, `ready` or `degraded`).

## Where things live

| Path | What |
|---|---|
| `~/.config/runpane-cloud/credentials.json` | boat key, Tailscale OAuth client, Anthropic key (0600). Override the directory with `RUNPANE_CLOUD_DIR` |
| `~/.config/runpane-cloud/settings.json` | golden image, default size, name prefix, runaway guard |
| `~/.config/runpane-cloud/hosts/<host>.json`, `.pairing` | one saved cloud Session and its pairing code (0600) |
| `~/.config/runpane-cloud/coordinator.json` | the coordinator's address and your caller token (0600) |
| `~/.pane/config.json` | Pane desktop's saved remote hosts; `new`, `sync` and `destroy` update it. Override with `--desktop-dir` or `RUNPANE_CLOUD_DESKTOP_DIR` (`PANE_DIR` is ignored on purpose) |
