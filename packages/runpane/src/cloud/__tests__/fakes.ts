import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JsonObject, JsonValue } from '../../boundaryDecoder';
import type { CloudDeps } from '../commands';
import { NO_COORDINATOR } from '../coordinatorSync';
import { encodePairingCode } from '../pairing';
import type { BootstrapPort, ProvisionRequest, TailnetDevice, TailnetPort } from '../ports';
import { CloudProviderError, type CloudProvider, type CloudSandbox, type CloudSize, type CreateSandboxRequest, type SandboxHandle } from '../provider';
import { createCloudStore } from '../store';

/**
 * In-memory fakes for the `runpane cloud` tests: a provider whose sandboxes move through states
 * on each poll, a tailnet, and a bootstrap that "joins" the tailnet and writes a pairing file.
 * Nothing here talks to the network.
 */

interface FakeSandbox extends CloudSandbox {
  /** States still to pass through, one per `get` call, before `state` settles. */
  pending: CloudSandbox['state'][];
}

interface FakeWorld {
  sandboxes: Map<string, FakeSandbox>;
  /** Directories pushed to the coordinator, oldest first; undefined = no coordinator configured. */
  pushedDirectories?: JsonObject[];
  failPush?: string;
  devices: TailnetDevice[];
  calls: string[];
  scripts: { sandboxId: string; script: string }[];
  healthy: Set<string>;
  failProvision?: string;
  /** Files written into sandboxes, by `<sandboxId>:<path>`. */
  files: Map<string, string>;
  /** Fake daemons: Sessions and peer records per sandbox hostname. */
  daemons: Map<string, FakeDaemon>;
  coordinatorHealthy: boolean;
  /** Shared by every fake provider instance, so ids stay unique across `createProvider` calls. */
  sandboxCounter: number;
  createdByKey: Map<string, string>;
  /** Hosts whose tailnet node comes back logged out after a resume (healthy again once repaired). */
  loggedOut: Set<string>;
  /** Hosts whose Tailscale Serve config a resume lost (Running, but /health unreachable until re-applied). */
  serveLost: Set<string>;
  /** When true, a coordinator is configured and `wake` goes through it. */
  coordinatorWakes?: boolean;
  /** When set, scoped keys longer than this many days are refused like boat does. */
  maxKeyTtlDays?: number;
  /** boat names sandboxes only through a later PATCH: create returns them unnamed when set. */
  createUnnamed?: boolean;
  /** What the daemon's safe-to-stop answers `cloud stop`; 'unreachable' makes the call fail. */
  safeToStop?: { safe: boolean; blockers: { condition: string; message: string }[] } | 'unreachable';
  failRename?: string;
}

export interface FakeDaemon {
  sessions: { id: string; name: string; archived?: boolean }[];
  peers: { id: string; label: string; sessions: string[] }[];
}

function createFakeWorld(): FakeWorld {
  return {
    sandboxes: new Map(), devices: [], calls: [], scripts: [], healthy: new Set(),
    files: new Map(), daemons: new Map(), coordinatorHealthy: true, sandboxCounter: 0, createdByKey: new Map(), loggedOut: new Set(), serveLost: new Set(),
  };
}

function createFakeProvider(world: FakeWorld): CloudProvider {
  const createdByKey = world.createdByKey;
  const need = (id: string): FakeSandbox => {
    const sandbox = world.sandboxes.get(id);
    if (!sandbox) throw new Error(`fake: no sandbox ${id}`);
    return sandbox;
  };
  const snapshot = (sandbox: FakeSandbox): CloudSandbox => ({
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    providerState: sandbox.state,
    size: sandbox.size,
  });
  const handle = (id: string): SandboxHandle => ({
    id,
    async runScript(script) {
      world.calls.push(`script ${id}`);
      world.scripts.push({ sandboxId: id, script });
      if (script.includes('tailscale ip -4')) return { exitCode: 0, stdout: '100.64.0.9\n', stderr: '' };
      const install = /install -m 600 (\S+) (\S+peers\.json)/u.exec(script);
      if (install) world.files.set(`${id}:${install[2]}`, world.files.get(`${id}:${install[1]}`) ?? '');
      return { exitCode: 0, stdout: script.includes('RP_AGENT_ENV') ? 'RP_AGENT_ENV ok\n' : 'RP_COORD ok\n', stderr: '' };
    },
    async writeFile(filePath, content) {
      world.calls.push(`write ${id} ${filePath}`);
      world.files.set(`${id}:${filePath}`, content);
    },
  });
  return {
    name: 'boat',
    async verifyCredentials() {
      return { account: 'fake@example.test' };
    },
    async create(request: CreateSandboxRequest) {
      world.calls.push(`create ${request.name} ${request.size} ${request.fromSnapshot ?? '-'}`);
      const existing = createdByKey.get(request.idempotencyKey);
      if (existing) return snapshot(need(existing));
      world.sandboxCounter += 1;
      const sandbox: FakeSandbox = {
        id: `bx_fake${String(world.sandboxCounter).padStart(4, '0')}`,
        name: world.createUnnamed ? '' : request.name,
        state: 'starting',
        providerState: 'provisioning',
        size: request.size,
        pending: ['starting'],
      };
      world.sandboxes.set(sandbox.id, sandbox);
      createdByKey.set(request.idempotencyKey, sandbox.id);
      return snapshot(sandbox);
    },
    async get(id) {
      const sandbox = world.sandboxes.get(id);
      if (!sandbox) return { id, name: '', state: 'gone', providerState: 'not_found' };
      const next = sandbox.pending.shift();
      if (next === undefined && sandbox.state === 'starting') sandbox.state = 'running';
      if (next === undefined && sandbox.state === 'stopping') sandbox.state = 'stopped';
      return snapshot(sandbox);
    },
    async list() {
      return [...world.sandboxes.values()].map(snapshot);
    },
    async rename(id, name) {
      world.calls.push(`rename ${id} ${name}`);
      if (world.failRename) throw new Error(world.failRename);
      need(id).name = name;
    },
    async stop(id) {
      world.calls.push(`stop ${id}`);
      const sandbox = need(id);
      sandbox.state = 'stopping';
      sandbox.pending = ['stopping'];
      for (const device of world.devices) if (device.hostname === sandbox.name) device.online = false;
    },
    async resume(id, options?: { size?: CloudSize }) {
      world.calls.push(`resume ${id}${options?.size ? ` ${options.size}` : ''}`);
      const sandbox = need(id);
      if (sandbox.state !== 'stopped') throw new Error('fake: resume of a sandbox that is not stopped');
      sandbox.state = 'starting';
      sandbox.pending = ['starting'];
      if (options?.size) sandbox.size = options.size;
      for (const device of world.devices) if (device.hostname === sandbox.name) device.online = true;
    },
    async destroy(id) {
      world.calls.push(`destroy ${id}`);
      world.sandboxes.delete(id);
    },
    handle,
    async createScopedKey(request) {
      if (world.maxKeyTtlDays !== undefined && Number.parseInt(request.ttl, 10) > world.maxKeyTtlDays) {
        throw new CloudProviderError('boat POST /api-keys/scoped failed with HTTP 403 (api_key_action_forbidden): A delegated key cannot outlive its parent.', 403, 'api_key_action_forbidden');
      }
      world.calls.push(`scoped-key ${request.name} ${request.actions.join(',')}`);
      return { id: 'sak_fake1', secret: 'scoped-secret-value' };
    },
    async revokeKey(keyId) {
      world.calls.push(`revoke-key ${keyId}`);
    },
  };
}

function createFakeTailnet(world: FakeWorld): TailnetPort {
  return {
    async findDevicesByHostname(hostname) {
      return world.devices.filter((device) => device.hostname === hostname).map((device) => ({ ...device }));
    },
    async deleteDevice(nodeId) {
      world.calls.push(`tailnet-delete ${nodeId}`);
      world.devices = world.devices.filter((device) => device.nodeId !== nodeId);
    },
  };
}

function createFakeBootstrap(world: FakeWorld): BootstrapPort {
  return {
    cloudHostname: (sessionId, prefix) => `${prefix}-${sessionId.slice(0, 8)}`,
    createTailnet: () => createFakeTailnet(world),
    async repairServe(sandbox, request) {
      world.calls.push(`repair-serve ${sandbox.id} ${request.transport}`);
      const host = [...world.sandboxes.values()].find((candidate) => candidate.id === sandbox.id)?.name ?? '';
      const serveApplied = world.serveLost.delete(host);
      return { backendState: 'Running', serveApplied, detail: serveApplied ? 'RE-APPLIED' : 'serve ok' };
    },
    async repairTailnet(sandbox, request) {
      world.calls.push(`repair ${sandbox.id} ${request.hostname}`);
      if (!world.loggedOut.has(request.hostname)) return { reenrolled: false, backendState: 'Running' };
      world.loggedOut.delete(request.hostname);
      if (request.hostname.endsWith('-coord')) world.coordinatorHealthy = true;
      world.devices = world.devices.filter((device) => device.hostname !== request.hostname);
      const nodeId = `n${request.hostname.replace(/-/g, '')}NEW`;
      world.devices.push({ nodeId, hostname: request.hostname, name: `${request.hostname}.tailtest.ts.net`, online: true });
      return { reenrolled: true, previousBackendState: 'NeedsLogin', nodeId, magicDnsName: `${request.hostname}.tailtest.ts.net`, deletedNodeIds: [request.oldNodeId ?? ''] };
    },
    async joinTailnet(sandbox, request) {
      world.calls.push(`join ${sandbox.id} ${request.hostname}`);
      const nodeId = `n${request.hostname.replace(/-/g, '')}CNTRL`;
      const magicDnsName = `${request.hostname}.tailtest.ts.net`;
      world.devices.push({ nodeId, hostname: request.hostname, name: magicDnsName, online: true });
      return { nodeId, magicDnsName, tailscaleIps: ['100.64.0.9'] };
    },
    async waitForDaemonHealth(baseUrl) {
      const host = new URL(baseUrl).hostname.split('.')[0];
      const sandbox = [...world.sandboxes.values()].find((candidate) => candidate.name === host);
      const ok = world.healthy.has(host) && !world.loggedOut.has(host) && !world.serveLost.has(host) && sandbox?.state === 'running';
      return ok ? { ok, elapsedMs: 1, status: 200, version: '2.4.141' } : { ok, elapsedMs: 1 };
    },
    async provision(sandbox: SandboxHandle, request: ProvisionRequest) {
      world.calls.push(`provision ${sandbox.id} ${request.hostname}`);
      if (world.failProvision) throw new Error(world.failProvision);
      const nodeId = `n${request.hostname.replace(/-/g, '')}CNTRL`;
      const magicDnsName = `${request.hostname}.tailtest.ts.net`;
      world.devices.push({ nodeId, hostname: request.hostname, name: magicDnsName, online: true });
      world.healthy.add(request.hostname);
      const code = encodePairingCode({
        v: 1,
        label: request.label,
        baseUrl: `https://${magicDnsName}`,
        token: `secret-token-${request.sessionId}`,
        transport: 'http+sse',
        tunnel: { kind: 'tailscale', selected: true },
      });
      await fs.mkdir(path.dirname(request.pairingOutputPath), { recursive: true });
      await fs.writeFile(request.pairingOutputPath, `${code}\n`, { mode: 0o600 });
      for (const extra of request.extraClients ?? []) {
        const extraCode = encodePairingCode({
          v: 1,
          label: extra.label,
          baseUrl: `https://${magicDnsName}`,
          token: `coordinator-token-${request.sessionId}`,
          transport: 'http+sse',
        });
        await fs.writeFile(extra.outputPath, `${extraCode}\n`, { mode: 0o600 });
      }
      return {
        hostname: request.hostname,
        magicDnsName,
        nodeId,
        baseUrl: `https://${magicDnsName}`,
        pairingPath: request.pairingOutputPath,
        daemonVersion: '2.4.141',
        timings: {},
      };
    },
  };
}

export interface TestHarness {
  deps: CloudDeps;
  world: FakeWorld;
  out: string[];
  err: string[];
  root: string;
  desktopDir: string;
}

export async function createTestHarness(): Promise<TestHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-cloud-test-'));
  const world = createFakeWorld();
  const out: string[] = [];
  const err: string[] = [];
  let clock = 1_000_000;
  const store = createCloudStore(path.join(root, 'cloud'));
  await store.writeCredentials({
    boat: { apiKey: 'boat-test-key' },
    tailscale: { clientId: 'client-id', clientSecret: 'client-secret' },
  });
  const deps: CloudDeps = {
    store,
    createProvider: () => createFakeProvider(world),
    bootstrap: createFakeBootstrap(world),
    readSecretFile: (file) => fs.readFile(file, 'utf8'),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    env: {},
    defaultDesktopDir: path.join(root, 'no-desktop-here'),
    async safeToStop(profile) {
      world.calls.push(`safe-to-stop ${profile.baseUrl}`);
      const answer = world.safeToStop ?? { safe: true, blockers: [] };
      if (answer === 'unreachable') throw new Error('connect ECONNREFUSED');
      return { ...answer, flushed: true };
    },
    async pushCoordinatorDirectory(directory) {
      if (!world.pushedDirectories) return { pushed: false, reason: NO_COORDINATOR };
      if (world.failPush) throw new Error(world.failPush);
      world.pushedDirectories.push(directory);
      const sessions = directory.sessions;
      return { pushed: true, sessions: Array.isArray(sessions) ? sessions.length : 0 };
    },
    async wakeViaCoordinator(sessionId) {
      if (!world.coordinatorWakes) return null;
      world.calls.push(`coordinator-wake ${sessionId}`);
      const sandbox = [...world.sandboxes.values()].find((candidate) => candidate.name.endsWith(sessionId.slice(0, 8)));
      if (!sandbox || sandbox.state !== 'stopped') return { status: 'lost' };
      sandbox.state = 'running';
      sandbox.pending = [];
      return { status: 'awake', version: '2.4.141-pinned', detail: 'upgraded to pinned 2.4.141-pinned' };
    },
    async packCoordinatorApp() {
      return { archiveBase64: 'ZmFrZQ==', version: '2.4.141-test' };
    },
    async probeCoordinatorHealth() {
      return world.coordinatorHealthy ? { ok: true, status: 200, version: '2.4.141-test' } : { ok: false };
    },
    async invokeDaemon(profile, channel, args): Promise<JsonValue | undefined> {
      const host = new URL(profile.baseUrl).hostname.split('.')[0];
      world.calls.push(`invoke ${host} ${channel}`);
      const daemon = world.daemons.get(host);
      if (!daemon) throw new Error('connect ECONNREFUSED');
      const request = args[0] ?? {};
      switch (channel) {
        case 'runpane:sessions:list':
          return { ok: true, sessions: daemon.sessions.map((session) => ({ id: session.id, name: session.name, archived: session.archived === true })) };
        case 'runpane:peers:mint': {
          const peer = { id: `peer-${daemon.peers.length + 1}`, label: String(request.label), sessions: Array.isArray(request.sessions) ? request.sessions.map(String) : [] };
          daemon.peers.push(peer);
          const connectionCode = encodePairingCode({ v: 1, label: host, baseUrl: profile.baseUrl, token: `peer-token-${peer.id}`, transport: 'http+sse' });
          return { ok: true, peer: { id: peer.id, label: peer.label, scope: 'peer', allowedSessionIds: peer.sessions }, connectionCode };
        }
        case 'runpane:peers:revoke': {
          const before = daemon.peers.length;
          daemon.peers = daemon.peers.filter((peer) => peer.id !== request.peer);
          if (daemon.peers.length === before) throw new Error('Unknown peer');
          return { ok: true, revoked: true, peerId: String(request.peer) };
        }
        default:
          throw new Error(`fake daemon: unexpected ${channel}`);
      }
    },
  };
  return { deps, world, out, err, root, desktopDir: path.join(root, 'desktop') };
}
