import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Notes for agents in a Runpane Cloud Session, kept by the Session's daemon in the user-level instruction
 * files Claude Code and Codex read (beside the CLI's runpane-cloud-github and runpane-cloud-secrets blocks).
 * The daemon writes them, not the CLI, so a Session gets the notes that match the Pane it runs, including
 * after an upgrade, without a repair.
 */
const NOTES_START = '<!-- runpane-cloud-ports:start -->';
const NOTES_END = '<!-- runpane-cloud-ports:end -->';
/** Written by the Session bootstrap on every Runpane Cloud Session (the same marker Session ports use). */
const CLOUD_SERVE_RECORD = '/etc/rp-cloud/serve.json';

export function portsAgentNotes(): string {
  return `${NOTES_START}
## Showing a web service from this runpane cloud Session

This Session is a cloud machine. The person you work for is not on it, so \`localhost\` links don't open for them.

- **Publish anything you serve** (dev server, preview, Storybook, docs): start it on 127.0.0.1 or 0.0.0.0, then run \`runpane port open <port> --name <name>\`. It prints a tailnet-only \`https://<host>.<tailnet>.ts.net:<port>/\` URL that opens on their laptop and phone.
- **Paste that https URL** in your reply, never a \`http://localhost:<port>\` address.
- **See what's published:** \`runpane port list\` (\`--verify\` requests each URL). **Stop publishing:** \`runpane port close <name>\`.
- If the page says the host is not allowed (Vite "Blocked request", webpack "Invalid Host header"), allow \`.ts.net\` in the dev server's allowed hosts.
- If the URL starts with \`http://\` (the Session has no TLS certificate yet), say so: sign-ins that use Secure cookies fail until it moves to https by itself.
- Ports in the repository's \`.runpane/ports.json\` are published automatically. Don't publish debuggers or database consoles unless asked.
${NOTES_END}`;
}

/** `text` with the marked block replaced where it is (or appended after a blank line); other text is kept. */
export function upsertMarkedBlock(text: string, block: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  if (to !== -1) return `${text.slice(0, from)}${block}${text.slice(to + end.length)}`;
  const rest = text.replace(/\n+$/u, '');
  return `${rest.trim() ? `${rest}\n\n` : ''}${block}\n`;
}

/** Writes the notes on a Runpane Cloud Session; returns the files it changed (none off a Session). */
export function writeSessionAgentNotes(options: { home?: string; serveRecordPath?: string } = {}): string[] {
  if (!fs.existsSync(options.serveRecordPath ?? CLOUD_SERVE_RECORD)) return [];
  const home = options.home ?? os.homedir();
  const block = portsAgentNotes();
  const changed: string[] = [];
  for (const file of [path.join(home, '.claude', 'CLAUDE.md'), path.join(home, '.codex', 'AGENTS.md')]) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const after = upsertMarkedBlock(before, block, NOTES_START, NOTES_END);
    if (after === before) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
    changed.push(file);
  }
  return changed;
}
