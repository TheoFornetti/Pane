import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import { RemoteDaemonClient } from '../remote/remoteDaemonClient';
import { createBoatProvider } from './boat';
import { cloudHostname, provisionSandbox, waitForDaemonHealth } from './bootstrap';
import { runCoordinatorCommand } from './coordinator';
import type { CloudDeps, CloudSafeToStopAnswer } from './commands';
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
    pushCoordinatorDirectory: (directory) => pushToCoordinator(path.join(store.dir, 'coordinator.json'), directory),
    safeToStop: (profile) => askSafeToStop(profile),
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

const safeToStopAnswerSchema = boundary.object({
  safe: boundary.boolean,
  blockers: boundary.array(boundary.object({ condition: boundary.string, message: boundary.string })),
  flush: boundary.nullable(boundary.json),
});

/** `runpane:cloud:safe-to-stop {flush: "always"}` over the host's paired token, for `cloud stop`. */
async function askSafeToStop(profile: { baseUrl: string; token: string }): Promise<CloudSafeToStopAnswer> {
  const client = new RemoteDaemonClient({
    profile: { id: 'runpane-cloud-stop', label: 'runpane cloud stop', baseUrl: profile.baseUrl, token: profile.token },
    runtimeId: 'runpane-cloud-stop',
    clientLabel: 'runpane cloud',
  });
  const result = decodeBoundary(
    await client.invoke('runpane:cloud:safe-to-stop', [{ flush: 'always' }], { timeoutMs: 60_000 }),
    safeToStopAnswerSchema,
  );
  return {
    safe: result.safe,
    blockers: result.blockers.map((blocker) => ({ condition: blocker.condition, message: blocker.message })),
    flushed: result.flush !== null,
  };
}

/** Reads a secret from a file, or from stdin for "-". Secrets never come from argv (visible in `ps`). */
async function readSecretFile(filePath: string): Promise<string> {
  if (filePath !== '-') return fs.readFile(filePath, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
