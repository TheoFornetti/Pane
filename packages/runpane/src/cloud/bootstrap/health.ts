import type { DaemonHealthResult } from './types';

export interface WaitForDaemonHealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Polls `GET <baseUrl>/health` (unauthenticated) until the daemon reports ready or the timeout
 * passes. Ready means HTTP 200 with `ok: true` and, when the daemon reports M2 readiness,
 * `readiness.state` "ready" or "degraded" (degraded is usable); older daemons only report
 * `status: "ready"`.
 */
export async function waitForDaemonHealth(
  baseUrl: string,
  options: WaitForDaemonHealthOptions = {},
): Promise<DaemonHealthResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  const started = Date.now();
  let last: Omit<DaemonHealthResult, 'elapsedMs'> = { ok: false };

  for (;;) {
    last = await probe(fetchImpl, url, requestTimeoutMs);
    const elapsedMs = Date.now() - started;
    if (last.ok || elapsedMs + intervalMs > timeoutMs) {
      return { ...last, elapsedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function probe(
  fetchImpl: typeof fetch,
  url: string,
  requestTimeoutMs: number,
): Promise<Omit<DaemonHealthResult, 'elapsedMs'>> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (response.status !== 200) {
      return { ok: false, status: response.status };
    }
    const body: unknown = await response.json();
    return { status: response.status, ...interpretHealthBody(body) };
  } catch {
    return { ok: false };
  }
}

export function interpretHealthBody(body: unknown): { ok: boolean; version?: string; readiness?: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false };
  }
  const record = body as Record<string, unknown>;
  const version = typeof record.version === 'string' ? record.version : undefined;
  const readinessRecord = typeof record.readiness === 'object' && record.readiness !== null
    ? record.readiness as Record<string, unknown>
    : undefined;
  const readiness = typeof readinessRecord?.state === 'string'
    ? readinessRecord.state
    : typeof record.status === 'string' ? record.status : undefined;
  const ready = readinessRecord
    ? readiness === 'ready' || readiness === 'degraded'
    : readiness === 'ready';
  return { ok: record.ok === true && ready, version, readiness };
}
