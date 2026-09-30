# Runpane Cloud coordinator

The coordinator is the always-on part of `runpane cloud`. It stops idle cloud Sessions, reconciles
the provider's sandboxes against the directory of cloud Sessions, guards against runaway spend, and
answers wake requests from peers. It is a small Node service with no dependencies beyond Node's
standard library. The code lives in `packages/runpane/src/cloud/coordinator/`.

The desktop app never talks to it (#695: Pane does not create or manage cloud machines).

## Where it runs

It runs on a tiny sandbox of its own (boat `small`), joined to the tailnet as `tag:rp-session`.

- **Why a sandbox, and why that tag.** The tailnet policy lets `tag:rp-session` nodes reach only other
  `tag:rp-session` nodes. A cloud Session therefore can't reach the user's laptop or any other member
  device. A peer that needs to wake a sleeping Session must reach the coordinator, so the coordinator has
  to be an `rp-session` node itself. Tailnet members, such as the laptop, can still reach it.
- **The address it listens on.** It binds only its tailnet IP. Sandboxes have public addresses, so the
  config refuses `0.0.0.0` and `::`. WireGuard encrypts the traffic, so the API is plain HTTP on port
  47300.
- **The systemd unit.** It runs as the user unit `runpane-cloud-coordinator.service` with linger enabled.
  It never uses `pane-remote-daemon`.
- **Its token on each Session.** `runpane cloud new` pairs the coordinator as a `scope: 'coordinator'`
  client (`pane --remote-setup --client-scope coordinator`). That token may call only
  `runpane:cloud:safe-to-stop` and `runpane:cloud:upgrade` (403 `ERR_COORDINATOR_CHANNEL_FORBIDDEN`
  otherwise); `/events` and WebSocket upgrades are refused. A leaked directory can't reach panels or shells.
- **The provider key.** It holds a scoped boat key with `sandbox.read`, `sandbox.stop` and
  `sandbox.resume` only (`POST /api-keys/scoped`). There is no create, fork or delete: `runpane cloud new`
  and `destroy` run on the laptop with the unscoped key. Scope the key to the Sessions' sandbox ids when
  you can. The provider interface also has no delete method, so the code can't destroy a sandbox either.
- **State.** The coordinator keeps no state that must persist (v4 I15). The provider and the directory
  are the truth. What it keeps in memory (wake times, safe-to-stop streaks, resume counts) only makes it
  more cautious after a restart.

## What it does

### Idle-stop (every `idleStop.intervalSeconds`, default 300)

For each Session in the directory whose sandbox is running, the coordinator checks, in order:

1. **Recently woken?** Skip it for `wakeGraceSeconds` (default 600) after a wake that resumed the
   sandbox. Asking to wake a host that is already awake doesn't start the grace, so a peer can't keep a
   host up by asking again and again. A user's wake of an awake host restarts the safe streak (step 4); a
   peer's does not.
2. **Daemon ready?** `GET /health` must answer and report ready. If the daemon is down, don't stop the
   sandbox; raise a `daemon-down` alert instead.
3. **Safe to stop?** Call `POST /invoke runpane:cloud:safe-to-stop` with the coordinator's own paired-client
   token. The daemon refuses while an agent is working, a terminal printed output recently, a lock is
   held, a watcher is active, a PR has pending checks, or a user client is attached. When it's safe, the
   daemon also checkpoints SQLite's WAL and fsyncs.
4. **Enough safe answers in a row?** Stop only after `requiredConsecutiveSafe` safe answers (default 2).
   Call boat stop immediately after the last one: boat snapshots about 4 s after the stop call and then
   powers off without sending SIGTERM.

Anything other than an explicit "safe" resets the streak and leaves the Session running: unsafe, an
error, no answer, an old daemon without the API, or no coordinator token.

### Reconcile (every `reconcile.intervalSeconds`, default 600)

The reconciler compares the provider's list with the directory. Only sandboxes whose name starts with
`managedNamePrefix` are considered, and never the coordinator's own sandbox or `ignoreSandboxIds`.

The reconciler **only stops and alerts. It never destroys.** It aborts without touching anything when:

- the directory can't be read (missing or invalid);
- the directory is empty while the provider lists managed sandboxes;
- the provider list fails;
- more running orphans would be stopped than `maxOrphanStopsPerRun` (default 3). A stale or truncated
  directory looks exactly like that.

If none of those apply, it stops running orphans older than `orphanGraceSeconds` (default 1800). The
grace period protects a sandbox from `runpane cloud new` that hasn't been synced to the directory yet. A
stopped orphan keeps its disk. Directory entries whose sandbox is gone or failed raise a `session-lost`
alert.

### Runaway guard

- **Live sandboxes.** The coordinator alerts when live managed sandboxes exceed `maxLiveSandboxes`
  (default 25, final-plan §4). At that count it also refuses to wake more.
- **Resume rate.** It caps resumes per sandbox (default 6 per hour) and overall (default 60 per hour).

### Wake

The wake API returns final-plan's statuses plus `awake`, which is the success answer:

| Status | Meaning |
|---|---|
| `awake` | Running, and `/health` is ready. For M2 daemons that means `readiness.state` is not `starting`. `degraded` counts as awake and is named in `detail`. |
| `asleep` | Stopped, or stopping. |
| `waking` | A resume was sent, the sandbox is booting, or `/health` isn't ready yet. A wait that times out also returns this. |
| `daemon-down` | Running for longer than `daemonDownGraceSeconds` (default 60), but `/health` doesn't answer. |
| `lost` | The provider reports an error, or no longer has the sandbox. |

How a wake behaves:

- **One resume per sandbox.** Concurrent wakes of the same sandbox share a single resume.
- **Idle-stop in progress.** A wake that arrives while idle-stop holds the sandbox waits for it to finish.
- **Provider start limits.** On boat these are account-wide: the `box_20` plan allows 60 starts an hour
  across every create, fork and resume. With `wait`, a `429` is retried with backoff until the deadline.
  After that the wake fails with `provider-rate-limited`.
- **Pinned version.** Once awake, if `/health.version` differs from the pinned version, the coordinator
  calls `runpane:cloud:upgrade {version, url, sha256}` and waits for `/health` to report that version.
  It only upgrades when the configured `.deb` belongs to that exact version. A daemon without the upgrade
  channel is reported as `version-mismatch`, and the wake doesn't fail.

## HTTP API

Every `/cloud/*` call needs `Authorization: Bearer rpc1.<callerId>.<mac>`, where `mac` is
`base64url(HMAC-SHA256(secret, "rpc1:" + callerId))`.

- **Peer callers.** The `callerId` is a cloud Session id. A peer token stops working as soon as that
  Session leaves the directory. Peers are limited to 60 requests a minute.
- **User callers.** The `callerId` is `user:<name>`, for the laptop CLI.
- **Revoking.** Revoke one caller with `revokedCallers`, or everyone by rotating the secret.

| Endpoint | Callers | Purpose |
|---|---|---|
| `GET /health` | anyone (no auth) | liveness and the coordinator's version |
| `GET /cloud/status?host=<id\|label\|tailnet name>` | peer, user | status **without** waking (for `workspace:wait` and `panels:list`) |
| `POST /cloud/wake {host, wait=true, timeoutMs}` | peer, user | wake (for `panels:submit` only). A peer may not wake its own sandbox (403 `peer-wake-refused`) and may cause at most 2 resumes per hour (429 `wake-rate-limited`) |
| `POST /cloud/reconcile {dryRun}` | user | run a reconcile pass now |
| `POST /cloud/idle-check {dryRun}` | user | run an idle-stop pass now |
| `GET /cloud/alerts?limit=` | user | recent alerts |
| `PUT /cloud/directory` | user | replace the directory. The laptop CLI is its single writer. |

Failure responses have the form `{ok:false, code, message}`:

| HTTP status | `code` |
|---|---|
| 404 | `unknown-host` |
| 503 | `directory-unreadable` |
| 429 | `runaway-guard`, `wake-rate-limited`, `provider-rate-limited` |
| 502 | `provider-error` |

Alerts go to three places:

- stderr, which lands in the journal;
- `<stateDir>/alerts.jsonl`;
- the optional `alerts.webhookUrl`.

## Directory

The directory is a JSON file on the coordinator (0600), written through `PUT /cloud/directory`:

```json
{ "version": 1, "generatedAt": "…",
  "sessions": [ { "sessionId": "…", "label": "…", "provider": "boat", "sandboxId": "bx_…",
                  "baseUrl": "https://rp-xxxxxxxx.<tailnet>.ts.net", "nodeId": "n…",
                  "pinnedVersion": null, "coordinatorToken": "<daemon token of the coordinator's paired client>" } ] }
```

- **The `coordinatorToken`.** Bootstrap pairs a second client on each Session's daemon, labelled
  `runpane-cloud-coordinator`, and this is its token.
- **User activity.** m2's safe-to-stop exempts every `runpane:cloud:*` invoke from the user-activity
  condition, so the coordinator's own calls never keep a Session awake.

## Setting it up

These steps run on the coordinator sandbox after it has joined the tailnet with a single-use
`tag:rp-session` key (the Session bootstrap's `tailscale-up` step):

```sh
M="node <app>/dist/cloud/coordinator/main.js"      # or: runpane cloud coordinator
$M init --listen-host "$(tailscale ip -4)" --api-key-file ~/.config/runpane-cloud-coordinator/boat-scoped-key \
        --managed-prefix rp- --self-sandbox-id <this sandbox id>
$M install-service --entry <app>/dist/cloud/coordinator/main.js
$M mint-token user:<you> --client-config /tmp/coordinator.json --base-url http://<coordinator tailnet name>:47300
```

1. Copy `coordinator.json` to the laptop as `$RUNPANE_CLOUD_DIR/coordinator.json` (0600) and delete the
   temporary copy.
2. From the laptop, run `push-directory`, `status`, `wake`, `reconcile [--dry-run]`, `idle-check`
   and `alerts` through the API. `--local` runs them in-process on the coordinator instead.
3. Take the coordinator down or bring it back with
   `systemctl --user stop|start runpane-cloud-coordinator`. Idle Sessions then just stay awake, and peers
   can't wake sleeping Sessions until it's back.
