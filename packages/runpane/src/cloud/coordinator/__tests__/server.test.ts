import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { MemoryAlertSink } from '../alerts';
import { authenticateCaller, mintCallerToken } from '../callerAuth';
import { createCoordinatorServer } from '../server';
import type { CoordinatorApi } from '../server';
import { entry, FakeClock, FakeDirectory } from './fakes';

const SECRET = 'test-secret';

describe('caller tokens', () => {
  const options = { secret: SECRET, revokedCallers: ['user:old'], isKnownPeer: async (id: string) => id === 's1' };

  it('accepts minted user and known-peer tokens', async () => {
    const user = await authenticateCaller(`Bearer ${mintCallerToken(SECRET, 'user:red')}`, options);
    assert.deepEqual(user, { ok: true, caller: { id: 'user:red', role: 'user' } });
    const peer = await authenticateCaller(`Bearer ${mintCallerToken(SECRET, 's1')}`, options);
    assert.deepEqual(peer, { ok: true, caller: { id: 's1', role: 'peer' } });
  });

  it('rejects missing, forged, revoked and unknown-peer tokens', async () => {
    assert.equal((await authenticateCaller(undefined, options)).ok, false);
    const forged = mintCallerToken('other-secret', 'user:red');
    const results = await Promise.all([
      authenticateCaller(`Bearer ${forged}`, options),
      authenticateCaller(`Bearer ${mintCallerToken(SECRET, 'user:old')}`, options),
      authenticateCaller(`Bearer ${mintCallerToken(SECRET, 's-removed')}`, options),
      authenticateCaller(`Bearer ${mintCallerToken(SECRET, 'user:red').replace('user:red', 'user:eve')}`, options),
    ]);
    assert.deepEqual(results.map((result) => (result.ok ? 'ok' : result.code)), [
      'auth-invalid',
      'auth-revoked',
      'auth-unknown-peer',
      'auth-invalid',
    ]);
  });
});

describe('coordinator HTTP server', () => {
  const calls: string[] = [];
  const api: CoordinatorApi = {
    status: async (host) => {
      calls.push(`status ${host}`);
      return host === 's1'
        ? { ok: true, host: 's1', label: 'one', sandboxId: 'bx_a', status: 'asleep', baseUrl: 'https://x', version: null, detail: '' }
        : { ok: false, code: 'unknown-host', message: 'nope' };
    },
    wake: async (host, request) => {
      calls.push(`wake ${host} wait=${request.wait}`);
      return { ok: true, host, label: 'one', sandboxId: 'bx_a', status: 'awake', baseUrl: 'https://x', version: '1', detail: '' };
    },
    reconcile: async () => {
      calls.push('reconcile');
      return { aborted: 'directory-empty', detail: '', managedCount: 1, directoryCount: 0, liveCount: 1, stopped: [], skipped: [], lost: [], dryRun: true };
    },
    idleCheck: async () => ({ ok: true, results: [] }),
  };
  const server = createCoordinatorServer({
    api,
    directory: FakeDirectory.of([entry('s1', 'bx_a')]),
    alerts: new MemoryAlertSink(),
    clock: new FakeClock(),
    secret: SECRET,
    revokedCallers: [],
    version: 'test',
    log: () => undefined,
  });
  let base = '';

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const request = async (path: string, init: RequestInit & { caller?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.caller) headers.set('Authorization', `Bearer ${mintCallerToken(SECRET, init.caller)}`);
    const response = await fetch(`${base}${path}`, { ...init, headers });
    return { status: response.status, body: await response.json() };
  };

  it('serves an unauthenticated /health', async () => {
    const response = await request('/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.service, 'runpane-cloud-coordinator');
  });

  it('requires a caller token on /cloud endpoints', async () => {
    assert.equal((await request('/cloud/status?host=s1')).status, 401);
  });

  it('lets a peer check status and wake', async () => {
    const status = await request('/cloud/status?host=s1', { caller: 's1' });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'asleep');
    const wake = await request('/cloud/wake', { method: 'POST', caller: 's1', body: JSON.stringify({ host: 's1' }) });
    assert.equal(wake.body.status, 'awake');
    assert.ok(calls.includes('wake s1 wait=true'));
    assert.equal((await request('/cloud/status?host=zzz', { caller: 's1' })).status, 404);
  });

  it('keeps reconcile and alerts for user callers only', async () => {
    assert.equal((await request('/cloud/reconcile', { method: 'POST', caller: 's1', body: '{}' })).status, 403);
    const reconcile = await request('/cloud/reconcile', { method: 'POST', caller: 'user:red', body: '{"dryRun":true}' });
    assert.equal(reconcile.status, 200);
    assert.equal(reconcile.body.report.aborted, 'directory-empty');
    assert.equal((await request('/cloud/alerts', { caller: 'user:red' })).status, 200);
  });

  it('rejects malformed wake bodies with 400', async () => {
    const response = await request('/cloud/wake', { method: 'POST', caller: 'user:red', body: '{"host":' });
    assert.equal(response.status, 400);
    const missingHost = await request('/cloud/wake', { method: 'POST', caller: 'user:red', body: '{}' });
    assert.equal(missingHost.status, 400);
  });
});
