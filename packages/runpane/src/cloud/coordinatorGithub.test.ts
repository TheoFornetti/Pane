import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { JsonValue } from '../boundaryDecoder';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { FakeGitHub } from './coordinator/github/__tests__/fakeGitHub';
import { parseCoordinatorGitHubArgs } from './coordinatorGithub';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// `runpane cloud coordinator github set|status|audit|unset` on the laptop, and `deploy` keeping the
// broker config on an in-place redeploy.

const STAGE = '/home/user/.runpane-cloud/coordinator-stage';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

async function deployed(): Promise<{ harness: TestHarness; sandboxId: string; statusCalls: string[] }> {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  harness.world.coordinatorHealthy = true;
  const statusCalls: string[] = [];
  harness.deps.callCoordinatorApi = async (method, pathAndQuery): Promise<{ status: number; body: JsonValue }> => {
    statusCalls.push(`${method} ${pathAndQuery}`);
    if (pathAndQuery.startsWith('/cloud/github/audit')) return { status: 200, body: { ok: true, entries: [{ at: 't', callerId: 's1', label: 'One', endpoint: 'POST push', repo: 'acme/app', target: 'cloud/rp-one/x', outcome: 'ok' }] } };
    return { status: 200, body: { ok: true, mode: 'app', app: { id: '42', slug: 'fake' }, repos: ['acme/app'], allowReadyPulls: false, tokens: [] } };
  };
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.ok(deployment);
  return { harness, sandboxId: deployment.sandboxId, statusCalls };
}

function stagedConfig(harness: TestHarness, sandboxId: string): { github: Record<string, JsonValue> | null } {
  return JSON.parse(harness.world.files.get(`${sandboxId}:${STAGE}/config.json`) ?? '{}');
}

test('coordinator github args: one credential, URLs in pairs', () => {
  assert.throws(() => parseCoordinatorGitHubArgs(['set']), /needs a credential/u);
  assert.throws(() => parseCoordinatorGitHubArgs(['set', '--app-id', '1']), /both --app-id and --private-key-file/u);
  assert.throws(() => parseCoordinatorGitHubArgs(['set', '--app-id', 'x', '--private-key-file', 'k']), /numeric App ID/u);
  assert.throws(() => parseCoordinatorGitHubArgs(['set', '--pat-file', 'p', '--app-id', '1', '--private-key-file', 'k']), /not both/u);
  assert.throws(() => parseCoordinatorGitHubArgs(['set', '--pat-file', 'p', '--api-base-url', 'http://x']), /go together/u);
  assert.equal(parseCoordinatorGitHubArgs(['set', '--pat-file', '-']).patFile, '-');
  assert.throws(() => parseCoordinatorGitHubArgs(['unset', '--app-id', '1']), /Unknown option/u);
});

test('github set (App) uploads the key 0600 through the files API, rewrites the config, and never prints the key', async () => {
  const { harness, sandboxId, statusCalls } = await deployed();
  const keyFile = path.join(harness.root, 'app.pem');
  await fs.writeFile(keyFile, PEM, { mode: 0o600 });
  assert.equal(await run(harness, ['coordinator', 'github', 'set', '--app-id', '42', '--private-key-file', keyFile, '--installation-id', '7', '--no-verify']), 0);

  assert.equal(harness.world.files.get(`${sandboxId}:${STAGE}/github-credential`), `${PEM.trim()}\n`);
  const script = harness.world.scripts.filter((entry) => entry.sandboxId === sandboxId).map((entry) => entry.script).pop() ?? '';
  assert.match(script, /install -m 600 "\$S\/github-credential" "\/home\/user\/\.config\/runpane-cloud-coordinator\/github\/app\.pem"/u);
  assert.match(script, /shred -u "\$S\/github-credential"/u);
  assert.match(script, /systemctl --user restart runpane-cloud-coordinator\.service/u);
  assert.ok(!script.includes('BEGIN RSA'), 'the key never appears in a script');
  assert.deepEqual(stagedConfig(harness, sandboxId).github, {
    mode: 'app',
    allowReadyPulls: false,
    appId: '42',
    privateKeyFile: '/home/user/.config/runpane-cloud-coordinator/github/app.pem',
    installationId: 7,
  });
  const saved = (await harness.deps.store.readSettings()).coordinator?.deployment?.github;
  assert.equal(saved?.mode, 'app');
  assert.ok(!JSON.stringify(await harness.deps.store.readSettings()).includes('PRIVATE KEY'));
  assert.ok(statusCalls.includes('GET /cloud/github/status'));
  assert.doesNotMatch([...harness.out, ...harness.err].join('\n'), /PRIVATE KEY/u);

  // An in-place redeploy keeps the broker config (the key file on the box is left alone).
  harness.world.files.delete(`${sandboxId}:${STAGE}/config.json`);
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes']), 0);
  assert.equal(stagedConfig(harness, sandboxId).github?.appId, '42');
  const redeploy = harness.world.scripts.filter((entry) => entry.sandboxId === sandboxId).map((entry) => entry.script).pop() ?? '';
  assert.doesNotMatch(redeploy, /runpane-cloud-coordinator\/github|rm -rf "\$C"/u);
  assert.match(harness.out.join('\n'), /GitHub broker kept \(App 42\)/u);

  // unset: config without github, credential shredded on the box.
  assert.equal(await run(harness, ['coordinator', 'github', 'unset', '--yes']), 0);
  assert.equal(stagedConfig(harness, sandboxId).github, null);
  const unsetScript = harness.world.scripts.filter((entry) => entry.sandboxId === sandboxId).map((entry) => entry.script).pop() ?? '';
  assert.match(unsetScript, /shred -u "\$f"/u);
  assert.equal((await harness.deps.store.readSettings()).coordinator?.deployment?.github, undefined);
});

test('github set refuses classic tokens and non-RSA keys before touching the coordinator', async () => {
  const { harness, sandboxId } = await deployed();
  const before = harness.world.scripts.length;
  const classic = path.join(harness.root, 'classic');
  await fs.writeFile(classic, 'ghp_0123456789abcdef0123456789abcdef0123\n', { mode: 0o600 });
  await assert.rejects(run(harness, ['coordinator', 'github', 'set', '--pat-file', classic, '--no-verify']), /refusing a ghp_/u);
  const notRsa = path.join(harness.root, 'ec.pem');
  const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await fs.writeFile(notRsa, ec.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  await assert.rejects(run(harness, ['coordinator', 'github', 'set', '--app-id', '1', '--private-key-file', notRsa, '--no-verify']), /RSA key/u);
  assert.equal(harness.world.scripts.length, before);
  assert.equal(harness.world.files.get(`${sandboxId}:${STAGE}/github-credential`), undefined);
});

test('github set verifies the App with GitHub: installation discovery, repos, and forbidden permissions', async () => {
  const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'rp-ghset-'));
  const fake = new FakeGitHub({ root, appId: '42', appPublicKey: PUBLIC_PEM });
  fake.createRepo('acme/app');
  const base = await fake.start();
  try {
    const { harness } = await deployed();
    const keyFile = path.join(harness.root, 'app.pem');
    await fs.writeFile(keyFile, PEM, { mode: 0o600 });
    assert.equal(await run(harness, ['coordinator', 'github', 'set', '--app-id', '42', '--private-key-file', keyFile, '--api-base-url', base, '--git-base-url', base, '--json']), 0);
    const summary = JSON.parse(harness.out[harness.out.length - 1]);
    assert.equal(summary.installationId, 4242);
    assert.deepEqual(summary.repos, ['acme/app']);
    assert.equal(summary.verifiedWithGitHub, true);
    assert.equal((await harness.deps.store.readSettings()).coordinator?.deployment?.github?.apiBaseUrl, base);

    await assert.rejects(run(harness, ['coordinator', 'github', 'set', '--app-id', '42', '--private-key-file', keyFile, '--installation-id', '9', '--api-base-url', base, '--git-base-url', base]), /no installation 9/u);
    await assert.rejects(run(harness, ['coordinator', 'github', 'set', '--app-id', '43', '--private-key-file', keyFile, '--api-base-url', base, '--git-base-url', base]), /401/u);
  } finally {
    await fake.stop();
    await fs.rm(root, { recursive: true, force: true });
  }

  const risky = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'rp-ghset-'));
  const broad = new FakeGitHub({ root: risky, appId: '42', appPublicKey: PUBLIC_PEM, installationPermissions: { contents: 'write', workflows: 'write', metadata: 'read' } });
  broad.createRepo('acme/app');
  const broadBase = await broad.start();
  try {
    const { harness } = await deployed();
    const keyFile = path.join(harness.root, 'app.pem');
    await fs.writeFile(keyFile, PEM, { mode: 0o600 });
    await assert.rejects(run(harness, ['coordinator', 'github', 'set', '--app-id', '42', '--private-key-file', keyFile, '--api-base-url', broadBase, '--git-base-url', broadBase]), /holds workflows permission/u);
  } finally {
    await broad.stop();
    await fs.rm(risky, { recursive: true, force: true });
  }
});

test('github status and audit read the coordinator API', async () => {
  const { harness } = await deployed();
  assert.equal(await run(harness, ['coordinator', 'github', 'status']), 0);
  assert.match(harness.out.join('\n'), /GitHub broker on .*: app \(App 42 "fake"\)/u);
  assert.equal(await run(harness, ['coordinator', 'github', 'audit', '--limit', '5']), 0);
  assert.match(harness.out[harness.out.length - 1], /One {2}POST push {2}acme\/app cloud\/rp-one\/x {2}ok/u);
});
