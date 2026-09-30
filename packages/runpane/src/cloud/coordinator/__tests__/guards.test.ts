import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RunawayGuard } from '../guards';
import { FakeClock, sandbox } from './fakes';

const LIMITS = { maxLiveSandboxes: 25, maxResumesPerSandboxPerHour: 1, maxResumesPerHour: 60 };

function historyFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guard-')), 'state', 'resumes.json');
}

describe('RunawayGuard resume history', () => {
  it('is shared through its file, so a second process (coordinator wake --local) sees the first one\'s resume', () => {
    const clock = new FakeClock();
    const file = historyFile();
    const service = new RunawayGuard(clock, LIMITS, file);
    const cli = new RunawayGuard(clock, LIMITS, file);
    const stopped = [sandbox('bx_a', 'stopped')];

    assert.deepEqual(cli.checkResume('bx_a', stopped), { ok: true });
    cli.recordResume('bx_a');
    const verdict = service.checkResume('bx_a', stopped);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok ? '' : verdict.code, 'wake-rate-limited');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    clock.time += 3_601_000;
    assert.deepEqual(new RunawayGuard(clock, LIMITS, file).checkResume('bx_a', stopped), { ok: true });
  });

  it('treats a missing or unreadable history as empty', () => {
    const clock = new FakeClock();
    const file = historyFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const guard = new RunawayGuard(clock, LIMITS, file);
    assert.deepEqual(guard.checkResume('bx_a', [sandbox('bx_a', 'stopped')]), { ok: true });
    guard.recordResume('bx_a');
    assert.equal(guard.checkResume('bx_a', [sandbox('bx_a', 'stopped')]).ok, false);
  });
});
