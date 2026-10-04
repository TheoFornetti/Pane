# Transcript usage indexing

UsageManager scans all JSONL files recursively beneath `~/.claude/projects`
and `~/.codex/sessions`, and Cursor agent transcripts under
`~/.cursor/projects/**/agent-transcripts/`. This includes Claude subagent
transcripts and Codex `year/month/day` directories. Roots are rediscovered on
every pass, including when their parent directories did not exist at startup.

## Cursor

Cursor transcripts are read only for chats Pane launched. Pane captures the
chat id when it starts `cursor-agent` (`agents/cursorLaunch.ts`) and stores it
in the panel's state; `cursorChats.ts` lists those ids with their Pane's
worktree. A transcript is matched by its file name, or the folder holding it,
being one of those ids. Everything else under `~/.cursor`, including the
Cursor editor's chats and chats started outside Pane, is never read. Rows
already indexed stay when their panel is removed.

Cursor's transcripts hold `{role, message}` lines and turn markers: no model,
time, or token counts. Each assistant line is one event with `metered = 0`,
model `cursor`, zero placeholder tokens, and the chat id and worktree from
Pane's launch record. The lines carry no time, so each message is timed at the
transcript's modification time when the scan read it. A chat's earlier messages
indexed in one pass therefore all land at its latest write.

Unmetered messages are counted, never priced: totals carry
`unmeteredMessageCount`, and any slice holding one has `costIncomplete`. The
dashboard, `runpane panes cost` and the leaderboard show them as "N messages,
tokens not reported". There are no Cursor limit bars.

Measured Cursor tokens are a follow-up: a Cursor `stop` hook that records each
turn's usage by `conversation_id`, pending a spike on a machine with Cursor.

Indexing runs at startup, every four hours, and on manual Refresh from the usage dashboard or Settings → Usage. There are
no native usage watchers or per-transcript watch handles. Unchanged files are
checked by metadata and skipped; changed files resume from their stored cursor.
The four-hour interval is a scheduling cadence, not a maximum freshness
bound: large scans can take longer. The usage page shows the last successful
scan and keeps errors visible until a subsequent successful pass.

All indexing uses a single queue. Requests made while a scan is running coalesce
into one follow-up discovery pass. A manual refresh waits for its requested pass,
including when an earlier pass is still running. Stop clears the polling timer
and invalidates queued and in-flight work. A lifecycle generation check after
asynchronous operations prevents stopped work from updating events, cursors,
quota samples or status. Restart queues fresh discovery after old reads drain.

Tests use generated transcripts in temporary directories and in-memory SQLite.
Run them with Node 22:

```sh
pnpm --filter main exec vitest run src/services/usage
```

Do not reproduce descriptor exhaustion against a user's real transcript trees.
For resource measurements, generate a disposable tree, constrain only child
processes, and delete only fixtures created by that run.

## Report queries

Reports read whole hours from `usage_hourly`, a per hour, provider, model and
cwd rollup of `usage_events`, with its unmetered message count, that triggers
keep in step with every insert and delete. A rollup from before
`unmetered_count` existed is rebuilt from the events once.

Rows whose provider this version does not know are left out of every report
and limit, never counted as another provider. Only the partial hours at each end of a range, and hours a custom-date
boundary falls inside, are read from raw events, so results match a scan of
every event. Pane attribution resolves each rollup row once; a row whose
events straddle a pane's creation or archive time rereads those events.
`usageAggregator.rollup.test.ts` holds every report to the per-event queries.

## Dashboard ranges and per-pane summaries

Usage & limits supports rolling 24h/7d/30d/90d presets and custom inclusive
calendar dates in the viewer's local time zone. Applying dates uses the existing
report query; it does not rescan transcripts. Historical reports contain only
indexed data, subject to the 180-day event retention window. Provider limits
continue to show current provider readings, regardless of the report range.

Per-pane usage defaults to an ordinary average across panes with recorded
usage in the selected period and provider filter, including archived panes.
Empty panes and unattributed events are excluded. Tokens per pane counts input,
output and cache-creation tokens, excluding cache reads. Cost includes all token
categories at estimated API rates, not subscription charges; any missing price
in the eligible sample makes the cost summary unavailable. Messages counts
recorded usage events, not human prompts.

The optional Trim 10% mode independently sorts each metric and removes
`floor(paneCount * 0.1)` values from each end before averaging. Fewer than ten
panes means no trimming. The UI shows the original and retained sample counts.
These summaries describe consumption during the selected period, not lifetime
task costs or completed work. They are derived from the existing report without
additional database queries. Leaderboard calculations are unchanged.

Custom-date charts use viewer-local midnight boundaries in a single indexed
range-join query, so day labels and totals remain aligned across daylight-saving
changes and fractional-hour time zones, including remote-daemon use. Calendar
defaults contain exactly the preset's number of inclusive dates.
