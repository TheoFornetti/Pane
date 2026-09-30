import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { parseDirectory } from './coordinator';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

function lastPushed(harness: TestHarness) {
  const pushed = harness.world.pushedDirectories ?? [];
  assert.ok(pushed.length > 0, 'expected a directory push');
  // The coordinator's own parser is the contract: what it rejects, the coordinator would refuse.
  return parseDirectory(pushed[pushed.length - 1]);
}

test('new pushes a directory the coordinator accepts, with the new host in it', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  assert.equal(await run(harness, ['new', '--label', 'Checkout', '--yes', '--no-import']), 0);
  const [record] = await harness.deps.store.listHosts();
  const directory = lastPushed(harness);
  assert.equal(directory.entries.length, 1);
  assert.deepEqual(directory.entries[0], {
    sessionId: record.profile.cloud.sessionId,
    label: 'Checkout',
    provider: 'boat',
    sandboxId: record.profile.cloud.sandboxId,
    baseUrl: record.profile.baseUrl,
    nodeId: record.profile.cloud.nodeId,
    pinnedVersion: null,
    coordinatorToken: null,
  });
  assert.match(harness.out.join('\n'), /coordinator: directory updated \(1 cloud Session\)/u);
});

test('with the coordinator enabled, new mints its client and the directory carries its token', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await harness.deps.store.writeSettings({ coordinator: { enabled: true } });
  assert.equal(await run(harness, ['new', '--yes', '--no-import']), 0);
  const [record] = await harness.deps.store.listHosts();
  assert.equal(lastPushed(harness).entries[0].coordinatorToken, `coordinator-token-${record.profile.cloud.sessionId}`);
  assert.doesNotMatch(harness.out.join('\n'), /coordinator-token-/u);
});

test('destroy pushes a directory without the destroyed host', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await run(harness, ['new', '--yes', '--no-import', '--label', 'a']);
  await run(harness, ['new', '--yes', '--no-import', '--label', 'b']);
  assert.equal(lastPushed(harness).entries.length, 2);
  assert.equal(await run(harness, ['destroy', 'a', '--yes', '--no-import']), 0);
  assert.deepEqual(lastPushed(harness).entries.map((entry) => entry.label), ['b']);
});

test('sync pushes too, and an empty directory is still a valid directory', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  assert.equal(await run(harness, ['sync', '--desktop-dir', harness.desktopDir, '--json']), 0);
  assert.equal(lastPushed(harness).entries.length, 0);
});

test('a failed push warns but never fails the command that already changed the world', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  harness.world.failPush = 'connect ETIMEDOUT';
  assert.equal(await run(harness, ['new', '--yes', '--no-import']), 0);
  assert.match(harness.err.join('\n'), /directory was not updated \(connect ETIMEDOUT\)\. Retry with: runpane cloud sync/u);
});

test('without a coordinator nothing is pushed and nothing is printed about it', async () => {
  const harness = await createTestHarness();
  assert.equal(await run(harness, ['new', '--yes', '--no-import']), 0);
  assert.doesNotMatch([...harness.out, ...harness.err].join('\n'), /coordinator/u);
});
