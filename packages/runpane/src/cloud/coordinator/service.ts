import type http from 'node:http';
import path from 'node:path';
import { JsonlAlertSink } from './alerts';
import { BoatCoordinatorProvider } from './boatProvider';
import type { CoordinatorConfig } from './config';
import { readSecretFile } from './config';
import { HttpDaemonProbe } from './daemonProbe';
import { FileSessionDirectory } from './directory';
import { RunawayGuard, SandboxActivity } from './guards';
import { IdleStopper } from './idleStop';
import { Reconciler } from './reconciler';
import { createCoordinatorServer } from './server';
import type { CoordinatorApi } from './server';
import type { AlertSink, Clock, CoordinatorProvider, DaemonProbe, SessionDirectory } from './types';
import { systemClock } from './types';
import { WakeService } from './wake';

export interface CoordinatorParts {
  config: CoordinatorConfig;
  clock: Clock;
  directory: SessionDirectory;
  provider: CoordinatorProvider;
  probe: DaemonProbe;
  alerts: AlertSink;
  api: CoordinatorApi;
}

export function buildCoordinator(
  config: CoordinatorConfig,
  overrides: Partial<Pick<CoordinatorParts, 'clock' | 'directory' | 'provider' | 'probe' | 'alerts'>> = {},
): CoordinatorParts {
  const clock = overrides.clock ?? systemClock;
  const directory = overrides.directory ?? new FileSessionDirectory(config.directoryFile);
  const provider = overrides.provider ?? new BoatCoordinatorProvider({
    apiBase: config.provider.apiBase,
    apiKey: readSecretFile(config.provider.apiKeyFile),
  });
  const probe = overrides.probe ?? new HttpDaemonProbe();
  const alerts = overrides.alerts ?? new JsonlAlertSink({
    clock,
    file: path.join(config.stateDir, 'alerts.jsonl'),
    webhookUrl: config.alerts.webhookUrl,
  });
  const activity = new SandboxActivity(clock);
  const guard = new RunawayGuard(clock, config.guards);
  const scope = {
    managedNamePrefix: config.managedNamePrefix,
    selfSandboxId: config.selfSandboxId,
    ignoreSandboxIds: config.ignoreSandboxIds,
  };
  const idle = new IdleStopper({ directory, provider, probe, activity, alerts }, {
    requiredConsecutiveSafe: config.idleStop.requiredConsecutiveSafe,
    wakeGraceMs: config.idleStop.wakeGraceSeconds * 1000,
    dryRun: config.idleStop.dryRun,
  });
  const reconciler = new Reconciler({ directory, provider, activity, guard, alerts, clock }, {
    ...scope,
    orphanGraceMs: config.reconcile.orphanGraceSeconds * 1000,
    maxOrphanStopsPerRun: config.reconcile.maxOrphanStopsPerRun,
    dryRun: config.reconcile.dryRun,
  });
  const wake = new WakeService({ directory, provider, probe, activity, guard, alerts, clock }, {
    ...scope,
    pinnedVersion: config.pinnedVersion,
    pinnedDebUrl: config.pinnedDebUrl,
    pinnedDebSha256: config.pinnedDebSha256,
    defaultTimeoutMs: config.wake.defaultTimeoutMs,
    maxTimeoutMs: config.wake.maxTimeoutMs,
    daemonDownGraceMs: config.wake.daemonDownGraceSeconds * 1000,
    pollIntervalMs: config.wake.pollIntervalMs,
    upgradeTimeoutMs: config.wake.upgradeTimeoutMs,
  });
  const api: CoordinatorApi = {
    status: (host) => wake.status(host),
    wake: (host, request) => wake.wake(host, request),
    reconcile: (options) => reconciler.runOnce(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    idleCheck: (options) => idle.runOnce(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  };
  return { config, clock, directory, provider, probe, alerts, api };
}

/** Runs `task` every `intervalMs`, never overlapping itself, until the returned stop function is called. */
function every(intervalMs: number, firstDelayMs: number, task: () => Promise<unknown>, onError: (error: unknown) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), firstDelayMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export interface RunningCoordinator {
  server: http.Server;
  close(): Promise<void>;
}

export async function startCoordinator(
  parts: CoordinatorParts,
  options: { version: string; log?: (line: string) => void; listenRetryMs?: number },
): Promise<RunningCoordinator> {
  const { config, api, alerts } = parts;
  const log = options.log ?? ((line: string) => console.log(line));
  const server = createCoordinatorServer({
    api,
    directory: parts.directory,
    alerts,
    clock: parts.clock,
    secret: readSecretFile(config.secretFile),
    revokedCallers: config.revokedCallers,
    version: options.version,
    log,
  });
  await listenWithRetry(server, config.listenHost, config.listenPort, options.listenRetryMs ?? 120_000, log);
  log(`[coordinator] listening on http://${config.listenHost}:${config.listenPort}`);

  const onError = (label: string) => (error: unknown) => {
    alerts.emit({ level: 'error', code: `${label}-crashed`, message: error instanceof Error ? error.message : String(error) });
  };
  const stops: Array<() => void> = [];
  if (config.idleStop.enabled) {
    stops.push(every(config.idleStop.intervalSeconds * 1000, 30_000, async () => {
      const report = await api.idleCheck({});
      const summary = report.results.map((r) => `${r.sessionId}=${r.decision}`).join(' ');
      log(`[coordinator] idle-check ${report.ok ? 'ok' : `failed: ${report.error}`} ${summary}`);
    }, onError('idle-check')));
  }
  if (config.reconcile.enabled) {
    stops.push(every(config.reconcile.intervalSeconds * 1000, 60_000, async () => {
      const report = await api.reconcile({});
      log(`[coordinator] reconcile ${report.aborted ? `ABORTED ${report.aborted}` : 'ok'}: ${report.detail}`);
    }, onError('reconcile')));
  }
  return {
    server,
    close: () => new Promise((resolve) => {
      for (const stop of stops) stop();
      server.close(() => resolve());
    }),
  };
}

async function listenWithRetry(
  server: http.Server,
  host: string,
  port: number,
  retryForMs: number,
  log: (line: string) => void,
): Promise<void> {
  // At boot the tailnet address may not exist yet (tailscaled still starting): retry EADDRNOTAVAIL.
  const until = Date.now() + retryForMs;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null;
      if (code !== 'EADDRNOTAVAIL' || Date.now() > until) throw error;
      log(`[coordinator] ${host} not available yet; retrying listen`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export function renderSystemdUnit(options: { nodePath: string; entryPath: string; configPath: string }): string {
  const quote = (value: string) => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`);
  return [
    '[Unit]',
    'Description=Runpane Cloud coordinator (idle-stop, reconcile, wake)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${quote(options.nodePath)} ${quote(options.entryPath)} serve --config ${quote(options.configPath)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
