import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { DaemonHealth, DaemonProbe, SafeToStopAnswer, UpgradeAnswer } from './types';

// Talks to a cloud Session's Pane daemon over the tailnet: GET /health (unauthenticated) and
// POST /invoke with the coordinator's own paired-client bearer token.

export const SAFE_TO_STOP_CHANNEL = 'runpane:cloud:safe-to-stop';
export const UPGRADE_CHANNEL = 'runpane:cloud:upgrade';

const healthSchema = boundary.object({
  ok: boundary.optional(boundary.boolean),
  status: boundary.optional(boundary.string),
  ready: boundary.optional(boundary.boolean),
  composersReady: boundary.optional(boundary.boolean),
  version: boundary.optional(boundary.nullable(boundary.string)),
  readiness: boundary.optional(boundary.nullable(boundary.jsonObject)),
});

const invokeSchema = boundary.object({
  ok: boundary.boolean,
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.object({
    message: boundary.optional(boundary.string),
    code: boundary.optional(boundary.string),
  })),
});

const reasonSchema = boundary.union(
  boundary.string,
  boundary.object({
    code: boundary.optional(boundary.string),
    detail: boundary.optional(boundary.string),
    message: boundary.optional(boundary.string),
  }),
);

const safeToStopResultSchema = boundary.object({
  safe: boundary.boolean,
  reasons: boundary.optional(boundary.array(reasonSchema)),
  checkpointed: boundary.optional(boundary.boolean),
});

/**
 * Readiness means "agents are usable", not just "the HTTP server answers". Accepts the /health shapes
 * the daemon may report: an explicit `ready` flag, `composersReady`, or a `readiness.ready` object;
 * a daemon without any of these (pre-M2 builds) is ready when `status` is "ready".
 */
export function decodeHealth(body: unknown): DaemonHealth {
  const health = decodeBoundary(body, healthSchema);
  const readinessReady = health.readiness && typeof health.readiness.ready === 'boolean'
    ? health.readiness.ready
    : undefined;
  const statusReady = health.status === undefined ? health.ok === true : health.status === 'ready';
  const ready = health.ready ?? readinessReady ?? (statusReady && (health.composersReady ?? true));
  return { reachable: true, ready, version: health.version ?? null };
}

export function decodeSafeToStop(result: unknown): SafeToStopAnswer {
  const decoded = decodeBoundary(result, safeToStopResultSchema);
  if (decoded.safe) return { kind: 'safe', checkpointed: decoded.checkpointed ?? false };
  const reasons = (decoded.reasons ?? []).map((reason) => (
    typeof reason === 'string'
      ? reason
      : [reason.code, reason.detail ?? reason.message].filter(Boolean).join(': ')
  ));
  return { kind: 'unsafe', reasons: reasons.length > 0 ? reasons : ['daemon reported unsafe without reasons'] };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HttpDaemonProbe implements DaemonProbe {
  private readonly fetchImpl: FetchLike;
  private readonly healthTimeoutMs: number;
  private readonly invokeTimeoutMs: number;

  constructor(options: { fetchImpl?: FetchLike; healthTimeoutMs?: number; invokeTimeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.healthTimeoutMs = options.healthTimeoutMs ?? 4000;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 60_000;
  }

  async health(baseUrl: string): Promise<DaemonHealth> {
    try {
      const response = await this.fetchImpl(`${baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
      return decodeHealth(await response.json());
    } catch (error) {
      return { reachable: false, error: describeError(error) };
    }
  }

  async safeToStop(baseUrl: string, token: string): Promise<SafeToStopAnswer> {
    const answer = await this.invoke(baseUrl, token, SAFE_TO_STOP_CHANNEL, [{}]);
    if (answer.kind !== 'ok') return answer;
    try {
      return decodeSafeToStop(answer.result);
    } catch (error) {
      return { kind: 'error', error: `unexpected safe-to-stop result: ${describeError(error)}` };
    }
  }

  async upgrade(baseUrl: string, token: string, version: string, debUrl: string | null): Promise<UpgradeAnswer> {
    const answer = await this.invoke(baseUrl, token, UPGRADE_CHANNEL, [{ version, debUrl }]);
    return answer.kind === 'ok' ? { kind: 'started' } : answer;
  }

  private async invoke(
    baseUrl: string,
    token: string,
    channel: string,
    args: unknown[],
  ): Promise<{ kind: 'ok'; result: unknown } | { kind: 'unsupported' | 'error'; error: string }> {
    try {
      const response = await this.fetchImpl(`${baseUrl}/invoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args }),
        signal: AbortSignal.timeout(this.invokeTimeoutMs),
      });
      const payload = decodeBoundary(await response.json(), invokeSchema);
      if (payload.ok) return { kind: 'ok', result: payload.result ?? null };
      const code = payload.error?.code ?? `HTTP ${response.status}`;
      const message = `${code}: ${payload.error?.message ?? 'daemon request failed'}`;
      return code === 'ERR_UNKNOWN_CHANNEL' ? { kind: 'unsupported', error: message } : { kind: 'error', error: message };
    } catch (error) {
      return { kind: 'error', error: describeError(error) };
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}
