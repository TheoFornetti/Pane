import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import { RemoteDaemonClient } from '../remote/remoteDaemonClient';
import { getWrapperVersion } from '../version';
import { createBoatProvider } from './boat';
import { cloudHostname, joinSandboxToTailnet, provisionSandbox, waitForDaemonHealth } from './bootstrap';
import { runCoordinatorCommand } from './coordinator';
import type { CloudDeps } from './commands';
import { callCoordinator, readClientConfig } from './coordinator/client';
import { NO_COORDINATOR, type CoordinatorPushResult } from './coordinatorSync';
import { defaultDesktopDir } from './desktop';
import type { BootstrapPort } from './ports';
import { createCloudStore } from './store';
import { createTailscaleApi } from './tailscale';

/** The real dependencies behind `runpane cloud`: boat REST, m1-bootstrap, the Tailscale API, local files. */
export function createDefaultCloudDeps(env: NodeJS.ProcessEnv = process.env): CloudDeps {
  const store = createCloudStore();
  const bootstrap: BootstrapPort = {
    cloudHostname,
    createTailnet: (credentials) => createTailscaleApi(credentials),
    waitForDaemonHealth: (baseUrl, options) => waitForDaemonHealth(baseUrl, options),
    async joinTailnet(sandbox, request, tailnet) {
      const node = await joinSandboxToTailnet(sandbox, {
        sessionId: request.sessionId,
        hostname: request.hostname,
        tailscale: createTailscaleApi(tailnet),
        onStep: (step) => {
          if (step.state === 'done') request.onStep?.(`${step.step} done${step.detail ? `: ${step.detail}` : ''}`);
        },
      });
      return { nodeId: node.nodeId, magicDnsName: node.magicDnsName, tailscaleIps: node.tailscaleIps };
    },
    async provision(sandbox, request, tailnet) {
      const result = await provisionSandbox(sandbox, {
        sessionId: request.sessionId,
        label: request.label,
        hostname: request.hostname,
        tailscale: createTailscaleApi(tailnet),
        paneSource: request.paneSource,
        repo: request.repo,
        pairingOutputPath: request.pairingOutputPath,
        extraClients: request.extraClients,
        healthTimeoutMs: request.healthTimeoutMs,
        onStep: (step) => {
          if (step.state === 'done') {
            request.onStep?.(`${step.step} done${step.elapsedMs !== undefined ? ` (${(step.elapsedMs / 1000).toFixed(1)} s)` : ''}${step.detail ? `: ${step.detail}` : ''}`);
          }
        },
      });
      return {
        hostname: result.hostname,
        magicDnsName: result.magicDnsName,
        nodeId: result.nodeId,
        baseUrl: result.baseUrl,
        pairingPath: result.pairingPath,
        daemonVersion: result.daemonVersion,
        timings: result.timings,
      };
    },
  };

  return {
    store,
    createProvider: (credentials) => {
      if (!credentials.boat) throw new Error('No boat API key saved. Run: runpane cloud setup --boat-key-file <path|->');
      return createBoatProvider({ apiKey: credentials.boat.apiKey });
    },
    bootstrap,
    readSecretFile,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env,
    defaultDesktopDir: defaultDesktopDir(env),
    runCoordinator: (argv) => runCoordinatorCommand(argv),
    pushCoordinatorDirectory: (directory) => pushToCoordinator(store.coordinatorClientPath, directory),
    packCoordinatorApp,
    probeCoordinatorHealth,
    async invokeDaemon(profile, channel, args, timeoutMs) {
      const client = new RemoteDaemonClient({ profile, runtimeId: 'runpane-cloud', clientLabel: 'runpane cloud' });
      return client.invoke(channel, args, { timeoutMs });
    },
  };
}

/**
 * PUT /cloud/directory on the coordinator named by `<cloud dir>/coordinator.json` ({baseUrl, token},
 * written by `runpane cloud coordinator mint-token --client-config`). No file means no coordinator.
 */
async function pushToCoordinator(clientConfigPath: string, directory: JsonObject): Promise<CoordinatorPushResult> {
  const client = readClientConfig(clientConfigPath);
  if (!client) return { pushed: false, reason: NO_COORDINATOR };
  const result = await callCoordinator(client, 'PUT', '/cloud/directory', directory, 60_000);
  if (result.status < 200 || result.status >= 300) {
    return { pushed: false, reason: `coordinator answered HTTP ${result.status}` };
  }
  const sessions = directory.sessions;
  return { pushed: true, sessions: Array.isArray(sessions) ? sessions.length : 0 };
}

/** Reads a secret from a file, or from stdin for "-". Secrets never come from argv (visible in `ps`). */
async function readSecretFile(filePath: string): Promise<string> {
  if (filePath !== '-') return fs.readFile(filePath, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

const execFileAsync = promisify(execFile);

/**
 * This CLI's package root (dist/cloud/wiring.js -> ../..), packed without maps and type declarations.
 * The coordinator is m4's zero-dependency service inside this same package, so the deployed
 * coordinator always matches the CLI that deployed it.
 */
async function packCoordinatorApp(): Promise<{ archiveBase64: string; version: string }> {
  const root = path.resolve(__dirname, '..', '..');
  await fs.access(path.join(root, 'dist', 'cloud', 'coordinator', 'main.js'));
  const { stdout } = await execFileAsync('tar', [
    '-czf', '-', '--exclude=*.map', '--exclude=*.d.ts', '-C', root, 'dist', 'package.json',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return { archiveBase64: stdout.toString('base64'), version: getWrapperVersion() };
}

const coordinatorHealthSchema = boundary.object({ ok: boundary.boolean, version: boundary.optional(boundary.string) });

async function probeCoordinatorHealth(baseUrl: string): Promise<{ ok: boolean; status?: number; version?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false, status: response.status };
    const body = decodeBoundary(await response.json(), coordinatorHealthSchema);
    return { ok: body.ok, status: response.status, version: body.version };
  } catch {
    return { ok: false };
  }
}
