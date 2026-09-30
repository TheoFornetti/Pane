import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { portsAgentNotes, upsertMarkedBlock, writeSessionAgentNotes } from './sessionAgentNotes';

const START = '<!-- runpane-cloud-ports:start -->';
const END = '<!-- runpane-cloud-ports:end -->';

describe('upsertMarkedBlock', () => {
  it('appends the block after existing text, separated by a blank line', () => {
    expect(upsertMarkedBlock('# Mine\n', `${START}\nnew\n${END}`, START, END)).toBe(`# Mine\n\n${START}\nnew\n${END}\n`);
  });

  it('replaces an older copy (moved to the end, like the CLI blocks) and keeps the other blocks', () => {
    const other = '<!-- runpane-cloud-github:start -->\ngh\n<!-- runpane-cloud-github:end -->';
    const before = `# Mine\n\n${START}\nold\n${END}\n\n${other}\n`;
    expect(upsertMarkedBlock(before, `${START}\nnew\n${END}`, START, END)).toBe(`# Mine\n\n${other}\n\n${START}\nnew\n${END}\n`);
  });

  it('writes just the block into an empty file', () => {
    expect(upsertMarkedBlock('', `${START}\nx\n${END}`, START, END)).toBe(`${START}\nx\n${END}\n`);
  });
});

describe('portsAgentNotes', () => {
  it('tells agents to publish with runpane port open and paste the https URL', () => {
    const notes = portsAgentNotes();
    expect(notes.startsWith(START)).toBe(true);
    expect(notes.endsWith(END)).toBe(true);
    expect(notes).toContain('runpane port open <port> --name <name>');
    expect(notes).toContain('runpane port list');
    expect(notes).toMatch(/never .*localhost/u);
  });
});

describe('writeSessionAgentNotes', () => {
  let root: string;
  let serveRecordPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notes-'));
    serveRecordPath = path.join(root, 'serve.json');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = () => [path.join(root, '.claude', 'CLAUDE.md'), path.join(root, '.codex', 'AGENTS.md')];

  it('does nothing off a Runpane Cloud Session', () => {
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([]);
    for (const file of files()) expect(fs.existsSync(file)).toBe(false);
  });

  it('writes the block into Claude and Codex notes on a Session, keeping what is there', () => {
    fs.writeFileSync(serveRecordPath, '{"transport":"https","port":42137}');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(files()[0] ?? '', '# My notes\n');

    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual(files());
    const claude = fs.readFileSync(files()[0] ?? '', 'utf8');
    expect(claude.startsWith('# My notes\n\n')).toBe(true);
    expect(claude).toContain(portsAgentNotes());
    expect(fs.readFileSync(files()[1] ?? '', 'utf8')).toBe(`${portsAgentNotes()}\n`);
  });

  it('leaves files alone when the block is already current', () => {
    fs.writeFileSync(serveRecordPath, '{}');
    writeSessionAgentNotes({ home: root, serveRecordPath });
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([]);
  });
});
