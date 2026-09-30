import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryAlertSink } from '../alerts';
import { RunawayGuard, SandboxActivity } from '../guards';
import { IdleStopper } from '../idleStop';
import type { ProviderSandbox } from '../types';
import { WakeService } from '../wake';
import type { WakeOptions, WakeResult } from '../wake';
import { entry, FakeClock, FakeDirectory, FakeProbe, FakeProvider, sandbox } from './fakes';

const URL_A = 'https://rp-s1.tail.ts.net';

function setup(sandboxes: ProviderSandbox[], options: Partial<WakeOptions> = {}, limits = { maxLiveSandboxes: 25, maxResumesPerSandboxPerHour: 6, maxResumesPerHour: 60 }) {
  const clock = new FakeClock();
  const provider = new FakeProvider(sandboxes);
  const probe = new FakeProbe();
  const directory = FakeDirectory.of([entry('s1', 'bx_a')]);
  const activity = new SandboxActivity(clock);
  const alerts = new MemoryAlertSink();
  const guard = new RunawayGuard(clock, limits);
  const wake = new WakeService({ directory, provider, probe, activity, guard, alerts, clock }, {
    managedNamePrefix: 'rp-',
    selfSandboxId: null,
    ignoreSandboxIds: [],
    pinnedVersion: null,
    pinnedDebUrl: null,
    pinnedDebSha256: null,
    defaultTimeoutMs: 90_000,
    maxTimeoutMs: 300_000,
    daemonDownGraceMs: 60_000,
    pollIntervalMs: 1000,
    upgradeTimeoutMs: 60_000,
    ...options,
  });
  return { clock, provider, probe, directory, activity, alerts, wake };
}

function status(result: WakeResult): string {
  return result.ok ? result.status : `error:${result.code}`;
}

describe('WakeService.status', () => {
  it('maps provider and /health state to the plan statuses without waking', async () => {
    const cases: Array<[ProviderSandbox, string]> = [
      [sandbox('bx_a', 'stopped'), 'asleep'],
      [sandbox('bx_a', 'stopping'), 'asleep'],
      [sandbox('bx_a', 'starting'), 'waking'],
      [sandbox('bx_a', 'failed'), 'lost'],
      [sandbox('bx_a', 'running'), 'awake'],
    ];
    for (const [item, expected] of cases) {
      const { wake, provider } = setup([item]);
      assert.equal(status(await wake.status('s1')), expected, item.state);
      assert.deepEqual(provider.mutations(), []);
    }
    const missing = setup([]);
    assert.equal(status(await missing.wake.status('s1')), 'lost');
  });

  it('reports daemon-down for a long-running sandbox whose daemon does not answer', async () => {
    const { wake, probe } = setup([sandbox('bx_a', 'running')]);
    probe.healthByUrl.set(URL_A, { reachable: false, error: 'ECONNREFUSED' });
    assert.equal(status(await wake.status('s1')), 'daemon-down');
  });

  it('resolves hosts by label and tailnet name, and rejects unknown hosts', async () => {
    const { wake } = setup([sandbox('bx_a', 'running')]);
    assert.equal(status(await wake.status('label-s1')), 'awake');
    assert.equal(status(await wake.status('rp-s1')), 'awake');
    assert.equal(status(await wake.status('nope')), 'error:unknown-host');
  });
});

describe('WakeService.wake', () => {
  it('resumes a sleeping sandbox and waits for /health readiness', async () => {
    const { wake, provider, probe } = setup([sandbox('bx_a', 'stopped')]);
    provider.bootAfterGets = 3;
    let healthChecks = 0;
    const original = probe.health.bind(probe);
    probe.health = async (baseUrl) => {
      healthChecks += 1;
      return healthChecks < 3 ? { reachable: false, error: 'booting' } : original(baseUrl);
    };
    const result = await wake.wake('s1', { wait: true });
    assert.equal(status(result), 'awake');
    assert.equal(provider.mutations().length, 1);
    assert.deepEqual(provider.mutations(), ['resume bx_a']);
  });

  it('returns waking immediately without wait', async () => {
    const { wake, provider } = setup([sandbox('bx_a', 'stopped')]);
    provider.bootAfterGets = 5;
    assert.equal(status(await wake.wake('s1', { wait: false })), 'waking');
    assert.equal(provider.mutations().length, 1);
  });

  it('shares one resume between concurrent wakes', async () => {
    const { wake, provider } = setup([sandbox('bx_a', 'stopped')]);
    provider.bootAfterGets = 2;
    const [first, second] = await Promise.all([wake.wake('s1', { wait: true }), wake.wake('label-s1', { wait: true })]);
    assert.equal(status(first), 'awake');
    assert.equal(status(second), 'awake');
    assert.equal(provider.mutations().filter((call) => call.startsWith('resume')).length, 1);
  });

  it('does not resume an awake sandbox', async () => {
    const { wake, provider } = setup([sandbox('bx_a', 'running')]);
    assert.equal(status(await wake.wake('s1', { wait: true })), 'awake');
    assert.deepEqual(provider.mutations(), []);
  });

  it('returns lost for a failed sandbox without resuming', async () => {
    const { wake, provider } = setup([sandbox('bx_a', 'failed')]);
    assert.equal(status(await wake.wake('s1', { wait: true })), 'lost');
    assert.deepEqual(provider.mutations(), []);
  });

  it('times out as waking when readiness never comes', async () => {
    const { wake, probe } = setup([sandbox('bx_a', 'stopped')]);
    probe.healthByUrl.set(URL_A, { reachable: true, ready: false, version: '1.0.0', detail: null });
    const result = await wake.wake('s1', { wait: true, timeoutMs: 10_000 });
    assert.equal(status(result), 'waking');
    assert.ok(result.ok && /timed out/.test(result.detail));
  });

  it('refuses to wake past the runaway limit and alerts', async () => {
    const { wake, provider, alerts } = setup(
      [sandbox('bx_a', 'stopped'), sandbox('bx_b', 'running'), sandbox('bx_c', 'running')],
      {},
      { maxLiveSandboxes: 2, maxResumesPerSandboxPerHour: 6, maxResumesPerHour: 60 },
    );
    assert.equal(status(await wake.wake('s1', { wait: true })), 'error:runaway-guard');
    assert.deepEqual(provider.mutations(), []);
    assert.equal(alerts.alerts[0].code, 'runaway-guard');
  });

  it('rate-limits repeated resumes of one sandbox', async () => {
    const { wake, provider } = setup([sandbox('bx_a', 'stopped')], {}, { maxLiveSandboxes: 25, maxResumesPerSandboxPerHour: 2, maxResumesPerHour: 60 });
    for (let index = 0; index < 2; index += 1) {
      assert.equal(status(await wake.wake('s1', { wait: true })), 'awake');
      await provider.stop('bx_a');
    }
    assert.equal(status(await wake.wake('s1', { wait: true })), 'error:wake-rate-limited');
  });

  it('upgrades to the pinned version after wake when the daemon supports it', async () => {
    const { wake, probe } = setup([sandbox('bx_a', 'stopped')], { pinnedVersion: '2.0.0', pinnedDebUrl: 'https://x/p.deb', pinnedDebSha256: 'abc' });
    probe.upgradeAnswer = { kind: 'started' };
    probe.healthAfterUpgrade = { reachable: true, ready: true, version: '2.0.0', detail: null };
    const result = await wake.wake('s1', { wait: true });
    assert.equal(status(result), 'awake');
    assert.ok(result.ok && result.version === '2.0.0');
    assert.ok(probe.calls.includes(`upgrade ${URL_A} 2.0.0 abc`));
  });

  it('reports version-mismatch but still wakes when the daemon has no upgrade hook', async () => {
    const { wake, alerts } = setup([sandbox('bx_a', 'stopped')], { pinnedVersion: '2.0.0', pinnedDebUrl: 'https://x/p.deb', pinnedDebSha256: 'abc' });
    const result = await wake.wake('s1', { wait: true });
    assert.equal(status(result), 'awake');
    assert.ok(result.ok && /version-mismatch/.test(result.detail));
    assert.ok(alerts.alerts.some((alert) => alert.code === 'version-mismatch'));
  });

  it('does not upgrade a per-Session pin with the coordinator-wide artifact of another version', async () => {
    const { wake, probe, directory } = setup([sandbox('bx_a', 'stopped')], {
      pinnedVersion: '2.0.0',
      pinnedDebUrl: 'https://x/p-2.0.0.deb',
      pinnedDebSha256: 'abc',
    });
    directory.result = { ok: true, generatedAt: null, entries: [entry('s1', 'bx_a', { pinnedVersion: '3.0.0' })] };
    probe.upgradeAnswer = { kind: 'started' };
    const result = await wake.wake('s1', { wait: true });
    assert.equal(status(result), 'awake');
    assert.ok(result.ok && /no pinnedDebUrl\/pinnedDebSha256 configured for 3.0.0/.test(result.detail));
    assert.ok(!probe.calls.some((call) => call.startsWith('upgrade')));
  });

  it('a wake keeps idle-stop away for the grace period', async () => {
    const { wake, provider, probe, directory, activity, alerts, clock } = setup([sandbox('bx_a', 'stopped')]);
    const idle = new IdleStopper({ directory, provider, probe, activity, alerts }, {
      requiredConsecutiveSafe: 1,
      wakeGraceMs: 600_000,
      dryRun: false,
    });
    await wake.wake('s1', { wait: true });
    assert.equal((await idle.runOnce()).results[0].decision, 'woken-recently');
    clock.time += 601_000;
    assert.equal((await idle.runOnce()).results[0].decision, 'stopped');
  });
});
