# Computer Use

Computer use lets a coding agent see and operate desktop apps on a Pane machine.
The agent calls the `js` tool on the [`pane` MCP server](PANE_MCP.md) with a
short JavaScript script. The script reads an app's accessibility tree, clicks,
types and scrolls, and returns text and screenshots. It works with any agent
that uses the `pane` MCP server: Claude Code, Codex, Cursor and others. It runs on
macOS, Windows, and Linux desktops with X11.

Typical uses:

- QA a desktop or Electron app the agent just changed, including Pane itself.
- Read what an app shows when it has no API or CLI.
- Finish a task that exists only in an app's UI.

Apps are driven in the background, so you can keep working while the agent
runs. Every action leaves a screenshot of the target window, and each run
leaves a replay.

## Turn it on

Computer use is off by default and is set per machine. Only you should turn it
on: agents get no MCP tool for it, and the skill tells them never to run the
command.

- **Desktop:** Settings → Remote Access → Computer use.
- **Headless host:** `runpane computer-use on`. Check it with
  `runpane computer-use status`. Each command takes `--json`.

<!-- P5-PENDING: status copy from plan P5; chunk D owns the final text. -->

Turning it on installs the engine, registers the `pane` MCP server, installs
the `pane-computer-use` skill for Claude Code, Codex and Cursor, checks OS
permissions and runs a self-test. The status shows the result:

| Status | Meaning |
|---|---|
| Off | Computer use is off on this machine. |
| Installing… | Pane is installing the engine. |
| Needs permission: *permission* | Click **Open System Settings** and grant the named permission to **Cua Driver** (on macOS it needs Accessibility and Screen Recording). The status rechecks when you return. |
| No desktop session | The machine has no graphical session to drive (for example a headless Linux server). |
| Self-test failed | View details shows what failed. |
| Ready · Cua Driver · checked *time* | Agents can use it. |

Leave the engine choice next to the switch on **Auto**. In this release Auto
and **Cua Driver** both use [Cua Driver](https://github.com/trycua/cua), an open-source
engine that Pane installs as a pinned release under its own data directory.

## What agents get

The `js` tool runs the script in a separate process on the target machine, one
per MCP connection, so each agent session starts fresh. Values the script stores on `globalThis` stay available
to that agent's next call. `js_reset` clears them, and they also clear after 10
idle minutes. A script stops after 300 seconds. Output is capped at about 25k
tokens.

`machine` picks the target machine. This release supports only the machine
running the agent.

Agents learn the API from the `pane-computer-use` skill and from the `js`
tool's description. The layer under the API:

- returns only what changed in an app's tree since the last read, unless the
  agent asks for the full tree;
- waits for the app to settle after each action, including while it shows a
  loading indicator;
- keeps an element's index stable across reads of the same window;
- queues actions on the same window, so two agents never interleave
  keystrokes; actions on different windows run in parallel.

## Background and foreground

Pane never moves focus on its own. When an app can't take an action in the
background on your OS, the agent gets a `needs_foreground` result. When no background route works, it may
retry that one action with `{ foreground: true }`. Pane shows a notice ("Pane:
*agent* is bringing *App* to the front") before the window comes forward.

## Apps Pane allows

Pane blocks no apps: password managers, terminals and system apps work like any
other. Turn computer use off on machines where agents should not touch the
desktop. The step screenshots record what each run did.

The skill tells agents to confirm with you before actions with outside effects
you didn't ask for, such as sending messages, payments, deleting data, or entering
personal data into a third-party site.

## Replays and pull requests

<!-- P4-PENDING: location and replay link from plan P4; chunk F owns the final text. -->

Each run saves one screenshot per step and a replay page that steps through
them with the action at each step. They live in the session's artifacts folder,
`~/.pane/artifacts/<session id>/` (or under `PANE_DIR` when set), and open from the pane. Archiving the
session deletes them, like its other artifacts.

Pane uploads nothing. When an agent opens a pull request, the skill tells it to
leave out frames that show secrets or unrelated windows, attach the rest, and
link the replay. On a public repository it asks you first.

The accessibility text and screenshots an agent reads go to its model provider,
like any other tool output.

## Turn it off

Switch it off in the same place, or run `runpane computer-use off`. A running
script stops, the engine exits, and the next call returns "Computer use is off
on this machine. Turn it on in Pane's Remote Access settings."

## Limits in this release

- Only the machine running the agent. Other machines answer "Only this machine
  is supported yet."
- Dragging on macOS needs `{ foreground: true }`.
- No live video, shared cursor or human takeover; screenshots and replays only.
