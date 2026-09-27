# Sessions

Sessions are named, ongoing Pane Chats where work intent lives. Each Session
opens one chat, and its sidebar row can expand to show associated Panes. The
optional overview keeps the Session name, associated Panes, and recent
activity together while the chat remains the focused work surface. A tab
shares its parent Pane's worktree.

In the sidebar, `+` opens an agent picker and an optional chat name field. Pane
remembers the chosen agent as the default for future Sessions while existing
Sessions keep their own agent. A blank name receives a generated name such as
`New chat` or `New chat 2`; each new Session opens as one Pane Chat and can be
renamed later from the optional read-only overview. Expand a Session to see
its associated Panes and open any Pane in its existing sidebar view.

The Sessions section below the divider can be collapsed from its header; the
`+` remains available while it is collapsed. Sessions are opened from this
section rather than from a duplicate top navigation shortcut.

The Session owns discussion, read-only code exploration and investigation,
clarification, and ticket creation or revision. After a ticket is ready and
the user explicitly authorizes implementation, the Session dispatches an
implementation session through RunPane in an appropriate existing Pane or
tab, or creates one when needed. It chooses the agent and the skills that fit
the work and names those skills by absolute path. The Session keeps its own
selected agent, profile, and tool configuration.

## Session sidebar and archive

Pinned is the first sidebar category and can contain both Session chats and
Panes. Right-click a Session to pin or unpin it. The pin preference survives
restarts; an archived Session stays out of Pinned until it is restored.

Click a Session row to open its chat and expand or collapse its associated
Panes. Child Pane rows are indented beyond the Session chat icon and keep the
ordinary Pane actions.

Right-click a Session to archive it. Archiving hides the chat from the active
Sessions list while retaining its identity, conversation history, and Pane
associations. Its Panes and worktrees remain accessible through repository
navigation. Restore the Session from the sidebar’s Archived section. This is
separate from archiving a project Pane and does not delete delegated work.

The existing Session update contract accepts `archived: true` or
`archived: false`. List results retain archived records; active navigation
filters them. Archiving the selected Session chooses an available active
Session or clears the selection if none remain. Restoring a Session does not
replace an unrelated selection.

## Session startup

Session setup is quiet. After routine context and liveness checks, a new
Session greets the user with a short invitation such as `Ready when you are.
What would you like to work on?`; a resumed Session briefly surfaces its saved
next step. Routine diagnostics, machine details, watcher output, and
workspace-wide Pane inventory stay internal unless the user asks or a relevant
failure needs attention. If one human action blocks progress, the Session
surfaces that single action clearly.

Unattended resilience is offered only when the user requests unattended work
or delegated work makes the choice relevant. The offer states its effect,
including keep-awake and automatic resume behavior. An explicit yes or no is
remembered for the Session; silence and unrelated prompts are not consent. A
new explicit no revokes resilience, while an enabled choice persists across
ordinary resumes and unrelated prompts.

## Pane association before delegation

Management is a Pane-level relationship; tabs inherit the relationship and
share the Pane's worktree. The orchestrator reads its own stable identity from
`PANE_ORCHESTRATION_SESSION_ID` and associates a Pane immediately after
creating it, or before delegating to an existing Pane. The supported command
is:

```text
runpane sessions associate --session <id|name> --pane <pane-id> [--json] [--pane-dir <path>]
```

Verify the result with `runpane sessions overview` and reuse an existing
association. A Pane already managed by another Session is a conflict: do not
detach, reassign, or create a duplicate Pane. Prefer creating a Pane without
an implementation prompt, associating and verifying it, then submitting the
prompt. Keep a Pane attached through idle and completion; do not detach on
completion. Archive behavior remains a separate #654 follow-up.

Before mutating, use `runpane agent-context --command 'sessions associate'
--json` to confirm the wrapper supports the command. If an older global CLI
does not, select and verify the app-compatible dev wrapper from the Pane
runtime context before proceeding. Never silently continue without the
association or substitute an unverified global/`npx` wrapper.

Sessions do not create worktrees and do not edit project implementation files.
An association identifies work that a Session coordinates; it does not grant
implementation authority by itself. Detach a Pane before assigning it to a
different Session.

## Stable interfaces

The shared record and service are:

- `shared/types/orchestrationSession.ts`
- `main/src/services/orchestrationSessionManager.ts`
- `orchestration-sessions.json` below `PANE_DIR`

The daemon and Electron IPC channels are:

`orchestration-sessions:list`, `orchestration-sessions:select`,
`orchestration-sessions:create`, `orchestration-sessions:get`,
`orchestration-sessions:update`, `orchestration-sessions:set-agent`,
`orchestration-sessions:associate`, `orchestration-sessions:detach`, and
`orchestration-sessions:overview`.

Selectors accept a stable Session ID or an exact Session name. The existing
`pane-chat:*` channels remain compatibility endpoints for the imported legacy
conversation.

RunPane exposes the corresponding commands:

```text
runpane sessions list --json
runpane sessions get --session <session-id-or-name> --json
runpane sessions overview --session <session-id-or-name> --json
runpane sessions create --from-json <path|-> --json
runpane sessions update --session <session-id-or-name> --from-json <path|-> --json
runpane sessions set-agent --session <session-id-or-name> --agent <agent> --json
runpane sessions associate --session <session-id-or-name> --pane <pane-id> --json
runpane sessions detach --session <session-id-or-name> --pane <pane-id> --json
```

Use `--from-json` for structured create and update input. Keep multiline
context, evidence, links, and reports in the JSON file or stdin; do not put
external text into shell source. Re-read mutation results and inspect the
overview after associations or updates.

## Resume and refresh persisted context

Read `PANE_ORCHESTRATION_SESSION_ID` from the current environment whenever a
Session conversation starts or resumes. Pane exports this stable identity for
Session panels, including agent resume paths that do not receive the original
bootstrap input. Do not infer the Session from a terminal panel ID or from
conversation text.

When the variable is present, reload the saved record and then reconcile live
Pane, tab, branch, and evidence state:

```text
runpane sessions get --session "$PANE_ORCHESTRATION_SESSION_ID" --json
runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json
```

Run `get` to recover persisted intent and associations, and run `overview`
after a resume or mutation. If the variable is missing, use `runpane sessions
list --json` to resolve a Session explicitly; never guess an identity. If the
stable ID cannot be resolved, report the error before taking Session-specific
actions.

## Identity and overview

Each orchestration Session has a stable ID, a hidden detached Pane session for
its conversation, and one deterministic terminal panel for each supported
agent. The imported legacy Pane Chat record retains its legacy internal IDs,
resume IDs, and terminal buffers. New Session records must not reuse those
identities.

When legacy Pane Chat contains history for more than one agent, each existing
agent history is imported as its own named Session. The imported rows retain
the original hidden Session, fixed panel, buffers, and resume ID; generated
unused panel slots keep those owners distinct across agent switches and
restarts.

The overview joins persisted intent with fresh Pane, tab, branch, worktree,
agent, and available Git or pull request evidence. Working, idle, stopped,
exited, missing, and archived states describe activity or availability. They
do not prove completion. A completion report must carry inspectable evidence,
the report timestamp, and provenance; new activity makes an older report
stale.

## Session watcher

Use one durable, named watcher per Session. `--session` takes the Session ID
or exact name, and the daemon follows every Pane associated with it:

```text
runpane watch --session <session-id> --follow --quiet --json \
  --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone,pane.associated,pane.detached,pr.conflicted,pr.checks,pr.merged \
  --settle 180000 --blocked-settle 30000 --min-interval 600000 \
  --idle-backoff
```

The daemon resolves the Session once per request and re-reads its
associations on every journal read. A Pane associated after the watcher
starts is included; a detached or archived Pane drops out, together with any
line still held for it by `--settle` or `--min-interval`. The Session's own
hidden owner and orchestrator panels never appear, and an association limited
to specific panels reports only those panels. There is no re-arm after
`sessions associate` or `sessions detach`. `--session` cannot be combined with
`--pane` or `--all-managed`, an unknown Session fails the watch, and a daemon
that predates `--session` fails it with `WATCH ERROR` instead of watching every
Pane.

Membership changes are journal entries: `pane.associated` (`JOINED <pane-name>
pane <pane-id> session <session-id>`) and `pane.detached` (`LEFT ...`). The
Session manager emits them from `sessions associate` (only when the Pane was
not already a member) and `sessions detach`. A watch without `--session`
receives them only when `--kinds` lists them, so older clients never see an
unknown kind. Cadence state is keyed by the Session rather than its current
Panes, so held lines survive membership changes.

PR events come from the daemon's Session PR monitor
(`main/src/services/sessionPrMonitor.ts`, decision D7). About every 3 minutes
(jittered) it visits each Pane associated with a Session that is not
archived. With no such Pane it runs no `gh` at all. A Pane whose PR is known to
be open gets `gh pr view <number> --json
number,url,state,mergeable,statusCheckRollup,headRefOid`. Any other member (no
cached PR because nobody has looked at it, or a closed or merged one) is first
looked up by branch with Pane's own `gh pr list --head <branch>` lookup, which
also updates the Pane's git status, so a background worker's new or reopened PR
is found within a round. All calls share the one-at-a-time `gh` slot Pane uses
for its own PR lookups, so a round costs at most two calls per member. It
appends, on transitions only:

- `pr.conflicted` (`PR <pane-name> pane <pane-id> #<number> CONFLICTED`): the
  PR now conflicts with its base. GitHub's transient `UNKNOWN` answer never
  counts as a change.
- `pr.checks` (`... CHECKS PASSED`, or `... CHECKS FAILED lint,test` with up to
  five names): every check on the head commit finished. A new head commit
  reports again once its checks finish.
- `pr.merged` (`... MERGED`). A merged PR is not polled again. A closed PR stops
  polling without an entry.

Entries carry `pr: {number, url, headOid}`, and `pr.checks` adds `checks` and
`failingChecks`. The first poll of a PR after the daemon starts only records
its state, so a restart never restates old conflicts; check `gh pr view` once
after a restart. `pr.conflicted` and failed `pr.checks` bypass
`--min-interval` like `BLOCKED`. The PR kinds are opt-in like `JOINED`/`LEFT`.
Without `gh`, or while it is signed out, rate limited, or timing out, the
monitor logs once, doubles its delay up to an hour, and resumes when `gh`
answers again.

The cursor defaults to `session-<uuid>`, where `<uuid>` is the UUID inside the
Session ID: the Session `__orchestration_session_<uuid>__` uses
`session-<uuid>`. Passing the name instead gives `session-<name>`. Cursor names
may be up to 128 characters (64 before this release); when runpane derives a
name itself, such as this default or the `PANE_PANEL_ID` fallback, it shortens
one longer than 64 characters (or one with other characters) to
`<prefix>-<first 12 hex characters of its sha256>`.

A discussion-only Session has no follow watcher. On restart, retain the
`session-<uuid>` cursor and capture a fresh output baseline before
interpreting notifications. After a reset (`_reset`), the baseline restates
current state: those JSON entries carry `replay: true` (and
`changedWhileAway: true` after a daemon restart). A replayed `agent.ready` is
never READY; re-read `sessions overview` instead of acting on it. Lines mode
prints only `CHANGED` for them. Return blocked and decision findings to the
Session conversation. Terminal idle or exit remains activity evidence only.

`--quiet` (alias `--no-control-lines`) drops the control lines that only prove
liveness: `_ok`, `_heartbeat`, and `_reconnected` (`WATCH OK`, `HEARTBEAT`,
and `WATCH RECONNECTED` in lines mode). `_error`, `_reset`, and `_dropped`
always print. Under `--follow`, JSON entries for a panel holding unsent
composer text carry `heldInputPresent: true`, the JSON form of `STUCK`.

### Watch profiles

| Profile | When | Flags | Worst-case READY delay |
|---|---|---|---|
| Unattended (default) | Overnight or background runs; every wake-up costs a full context replay | `--settle 180000 --blocked-settle 30000 --min-interval 600000 --idle-backoff` | about 13 minutes |
| User present | Someone is waiting on the result | `--settle 60000 --blocked-settle 15000 --min-interval 120000`, no `--idle-backoff` | about 3 minutes |

Both profiles use the same `--kinds` list, `--quiet`, and named cursor.
Switch profiles by re-arming the same cursor.

## Skill contract

`main/src/services/skillCacheManager.ts` installs the skills that ship in
`main/src/services/paneChatBundle/` once per run: into
`<PANE_DIR>/skills/pane-chat/skills/` and into the `.claude/skills/` and
`.codex/skills/` folders of the data directory. It also generates the
`pane-orchestrator` entry skill, the runtime context, and the helper subagents
in `.claude/agents/` and `.codex/agents/`. A manifest records what it
installed, so later installs replace only those entries.

The Session route depends on `pane-orchestrator`, `runpane`,
`orchestrate-sessions`, `create-ticket`, and `pane-work`. Agents dispatched to
other repositories get skills by absolute path from the Session's prompt.
