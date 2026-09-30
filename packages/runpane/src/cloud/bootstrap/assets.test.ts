import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cloudBootstrapAssets, type CloudBootstrapAssetName } from './generated/assets';

const names = Object.keys(cloudBootstrapAssets) as CloudBootstrapAssetName[];

test('every embedded asset is valid bash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, cloudBootstrapAssets[name]);
    const result = childProcess.spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test('the bootstrap never enables Tailscale SSH and never mv-s into kept paths', () => {
  for (const name of names) {
    const text = cloudBootstrapAssets[name];
    assert.ok(!/tailscale up[^\n]*--ssh(?!=false)/.test(text), `${name} must not run tailscale up --ssh`);
    assert.ok(!/^\s*(sudo )?mv /m.test(text), `${name} must not mv files (M0: mv into kept paths arrives empty)`);
  }
});

test('an unknown step fails with a parsable result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const result = childProcess.spawnSync('bash', [file, 'nope'], {
    encoding: 'utf8',
    env: { ...process.env, RP_STATE: path.join(dir, 'state') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RP_RESULT \{"ok": false, "error": "unknown step 'nope'"\}$/m);
});
