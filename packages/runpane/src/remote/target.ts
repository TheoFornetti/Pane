import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../boundaryDecoder';
import { CoordinatorClient, CoordinatorError, type CloudHostState } from './coordinatorClient';
import { resolveDaemonTarget, type DaemonTarget } from './hostDirectory';
import {
  RemoteAuthError,
  RemoteConnectError,
  RemoteDaemonClient,
  RemoteRequestError,
  RemoteUnconfirmedResultError,
  nodeHttpTransport,
  type RemoteDaemonClientOptions,
  type RemoteHttpTransport,
} from './remoteDaemonClient';

/** An error with a stable `code` that daemonClient turns into a PaneDaemonClientError. */
export class RemoteTargetError extends Error {
  override name = 'RemoteTargetError';

  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Only a submit may wake a sleeping cloud host (plan S3: "Only submit triggers a wake"). */
const WAKING_CHANNELS = new Set(['runpane:panels:submit', 'runpane:panels:submit-composer']);
const IDEMPOTENT_SUBMIT_CHANNEL = 'runpane:panels:submit';
/** `--panel orchestrator` names the target Session's orchestrator panel. */
const ORCHESTRATOR_PANEL_SELECTOR = 'orchestrator';
const DEFAULT_WAKE_WAIT_MS = 90_000;
const RESEND_INTERVAL_MS = 2_000;
// Local Pane terminal ids name panels on this host, never on the target.
const LOCAL_IDENTITY_ENV = ['PANE_SESSION_ID', 'PANE_PANEL_ID', 'PANE_ORCHESTRATION_SESSION_ID'];

let activeTarget: DaemonTarget | null = null;

export interface TargetSelection {
  host?: string;
  thread?: string;
  paneDir?: string;
}

/**
 * Picks the daemon every `invokeDaemon` call in this process talks to:
 * `--thread` (cloud Sessions only), else `--host`, else `$RUNPANE_HOST`,
 * else the local socket. The CLI is one-shot, so this is process state.
 */
export function configureDaemonTarget(selection: TargetSelection, env: NodeJS.ProcessEnv = process.env): DaemonTarget | null {
  if (selection.host && selection.thread) {
    throw new Error('Use either --host or --thread, not both.');
  }
  const selector = selection.thread ?? selection.host ?? env.RUNPANE_HOST?.trim();
  if (!selector) {
    activeTarget = null;
    return null;
  }
  activeTarget = resolveDaemonTarget(selector, { env, paneDir: selection.paneDir, cloudOnly: Boolean(selection.thread) });
  for (const name of LOCAL_IDENTITY_ENV) delete env[name];
  return activeTarget;
}

export function getDaemonTarget(): DaemonTarget | null {
  return activeTarget;
}

export function resetDaemonTarget(): void {
  activeTarget = null;
}

export interface InvokeRemoteOptions {
  timeoutMs: number;
  transport?: RemoteHttpTransport;
  wakeWaitMs?: number;
  resendIntervalMs?: number;
  retryDelayMs?: number;
}

/**
 * Sends one channel call over HTTP `/invoke`. When the connection never opens
 * and the target is a cloud host: a submit asks the coordinator to wake it and
 * then resends the same request (same idempotency key); anything else asks for
 * the status only and fails with ERR_RUNPANE_HOST_<STATUS>.
 */
export async function invokeRemote(
  target: DaemonTarget,
  channel: string,
  args: unknown[],
  options: InvokeRemoteOptions,
): Promise<JsonValue | undefined> {
  const transport = options.transport ?? nodeHttpTransport;
  const startedAt = Date.now();
  let baseUrl = target.host.baseUrl;
  const client = () => {
    const clientOptions: RemoteDaemonClientOptions = {
      profile: { ...target.host, baseUrl },
      runtimeId: cliRuntimeId(),
      clientLabel: `runpane CLI (${os.hostname()})`,
      transport,
    };
    if (options.retryDelayMs !== undefined) clientOptions.retryDelayMs = options.retryDelayMs;
    return new RemoteDaemonClient(clientOptions);
  };

  // The key is fixed once, so every resend is the same logical submit.
  const requestArgs = withIdempotencyKey(channel, args);
  const deliver = async () => {
    const resolved = await resolveOrchestratorPanel(channel, requestArgs, (listArgs) => (
      client().invoke('runpane:panels:list', listArgs, { timeoutMs: 30_000 })
    ));
    return client().invoke(channel, resolved, { timeoutMs: options.timeoutMs });
  };
  try {
    return await deliver();
  } catch (error) {
    if (!(error instanceof RemoteConnectError)) throw error instanceof Error ? toTargetError(error, target) : error;
  }

  // The connection never opened, so the host cannot have seen the request.
  const cloud = target.host.cloud;
  if (!cloud || !target.coordinator) {
    throw new RemoteTargetError(
      `Could not reach ${target.host.label} at ${baseUrl}. ` +
      (cloud ? 'No runpane cloud coordinator is configured, so it cannot be woken from here.' : 'Is the host up and on your tailnet?'),
      'ERR_RUNPANE_HOST_UNREACHABLE',
    );
  }
  const coordinator = new CoordinatorClient(target.coordinator, transport);
  const wakeWaitMs = options.wakeWaitMs ?? DEFAULT_WAKE_WAIT_MS;

  let state: CloudHostState;
  try {
    state = WAKING_CHANNELS.has(channel)
      ? await coordinator.wake(cloud.sessionId, wakeWaitMs)
      : await coordinator.status(cloud.sessionId);
  } catch (error) {
    if (error instanceof CoordinatorError) throw new RemoteTargetError(error.message, error.code);
    throw error;
  }
  // A re-enrolled host keeps its name but may come back with a new address.
  if (state.baseUrl) baseUrl = state.baseUrl;

  if (!WAKING_CHANNELS.has(channel) && state.status !== 'awake') {
    throw hostStateError(target, state, false);
  }
  const deadline = startedAt + wakeWaitMs + options.timeoutMs;
  if (state.status === 'waking') {
    state = await pollUntilSettled(coordinator, cloud.sessionId, deadline, options.resendIntervalMs ?? RESEND_INTERVAL_MS);
    if (state.baseUrl) baseUrl = state.baseUrl;
  }
  if (state.status !== 'awake') {
    throw hostStateError(target, state, WAKING_CHANNELS.has(channel));
  }

  // Resend while the connection keeps failing to open (MagicDNS and routes can
  // lag the wake by a few seconds). Once it opens, the answer is final.
  for (;;) {
    try {
      return await deliver();
    } catch (error) {
      if (!(error instanceof RemoteConnectError)) throw error instanceof Error ? toTargetError(error, target) : error;
      if (Date.now() + (options.resendIntervalMs ?? RESEND_INTERVAL_MS) > deadline) {
        throw new RemoteTargetError(
          `${target.host.label} woke up but its daemon did not accept connections in time (${error.message}).`,
          'ERR_RUNPANE_HOST_DAEMON_DOWN',
        );
      }
      await delay(options.resendIntervalMs ?? RESEND_INTERVAL_MS);
    }
  }
}

async function pollUntilSettled(
  coordinator: CoordinatorClient,
  host: string,
  deadline: number,
  intervalMs: number,
): Promise<CloudHostState> {
  let state: CloudHostState = { status: 'waking' };
  while (state.status === 'waking' && Date.now() + intervalMs <= deadline) {
    await delay(intervalMs);
    state = await coordinator.status(host);
  }
  return state;
}

function hostStateError(target: DaemonTarget, state: CloudHostState, woke: boolean): RemoteTargetError {
  const name = target.host.label;
  const detail = state.detail ? ` (${state.detail})` : '';
  const code = `ERR_RUNPANE_HOST_${state.status.toUpperCase().replace(/-/g, '_')}`;
  switch (state.status) {
    case 'asleep':
      return new RemoteTargetError(
        `Cloud host ${name} is asleep${detail}. Only panels submit wakes a host; run \`runpane cloud wake ${name}\` to wake it.`,
        code,
      );
    case 'waking':
      return new RemoteTargetError(`Cloud host ${name} is still waking up${detail}. Try again in a few seconds.`, code);
    case 'daemon-down':
      return new RemoteTargetError(`Cloud host ${name} is running but its Pane daemon is not answering${detail}.`, code);
    case 'lost':
      return new RemoteTargetError(`Cloud host ${name} is lost: the provider no longer has it${detail}.`, code);
    case 'awake':
      return new RemoteTargetError(
        `Cloud host ${name} is awake${woke ? ' after a wake' : ''}, but ${target.host.baseUrl} did not accept a connection${detail}.`,
        'ERR_RUNPANE_HOST_UNREACHABLE',
      );
  }
}

function toTargetError(error: Error, target: DaemonTarget): Error {
  if (error instanceof RemoteRequestError) {
    return new RemoteTargetError(error.message, error.code ?? `ERR_RUNPANE_REMOTE_HTTP_${error.status}`);
  }
  if (error instanceof RemoteAuthError) {
    return new RemoteTargetError(`${target.host.label}: ${error.message}`, 'ERR_RUNPANE_REMOTE_AUTH');
  }
  if (error instanceof RemoteUnconfirmedResultError) {
    return new RemoteTargetError(error.message, 'ERR_RUNPANE_REMOTE_UNCONFIRMED');
  }
  return error;
}

/** A submit over HTTP always carries an idempotency key, so a resend after a wake delivers once. */
function withIdempotencyKey(channel: string, args: unknown[]): unknown[] {
  if (channel !== IDEMPOTENT_SUBMIT_CHANNEL) return args;
  const request = firstRequestObject(args);
  if (!request || request.idempotencyKey !== undefined) return args;
  return [{ ...request, idempotencyKey: `runpane-cli:${randomUUID()}` }, ...args.slice(1)];
}

/** The request object a runpane channel takes as its first argument, or null. */
function firstRequestObject(args: unknown[]): JsonObject | null {
  try {
    return decodeBoundary(args[0], boundary.jsonObject);
  } catch {
    return null;
  }
}

const panelListSchema = boundary.object({
  panels: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    title: boundary.optional(boundary.nullable(boundary.string)),
  })),
});

/** Resolves `--panel orchestrator` through the target's `panels:list`, which lists only orchestrator panels for a peer. */
async function resolveOrchestratorPanel(
  channel: string,
  args: unknown[],
  listPanels: (args: unknown[]) => Promise<JsonValue | undefined>,
): Promise<unknown[]> {
  if (!WAKING_CHANNELS.has(channel)) return args;
  const request = firstRequestObject(args);
  if (!request || request.panelId !== ORCHESTRATOR_PANEL_SELECTOR) return args;
  const { panels } = decodeBoundary(await listPanels([{}]), panelListSchema);
  if (panels.length !== 1) {
    const found = panels.map((panel) => `${panel.id}${panel.title ? ` (${panel.title})` : ''}`).join(', ') || 'none';
    throw new RemoteTargetError(
      `--panel orchestrator needs exactly one orchestrator panel on the target; found ${panels.length}: ${found}. Pass --panel <id>.`,
      'ERR_RUNPANE_ORCHESTRATOR_AMBIGUOUS',
    );
  }
  return [{ ...request, panelId: panels[0]!.id }, ...args.slice(1)];
}

/** Stable per machine and user without writing a file: the daemon keys remote viewers by it. */
function cliRuntimeId(): string {
  const uid = process.getuid ? String(process.getuid()) : os.userInfo().username;
  return `runpane-cli-${createHash('sha256').update(`${os.hostname()}:${uid}`).digest('hex').slice(0, 16)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
