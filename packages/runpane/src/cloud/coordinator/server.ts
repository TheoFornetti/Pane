import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import { authenticateCaller } from './callerAuth';
import type { Caller } from './callerAuth';
import type { IdleCheckReport } from './idleStop';
import type { ReconcileReport } from './reconciler';
import type { AlertSink, Clock, SessionDirectory } from './types';
import type { WakeFailureCode, WakeResult } from './wake';

const MAX_BODY_BYTES = 16 * 1024;
const PEER_REQUESTS_PER_MINUTE = 60;

const wakeBodySchema = boundary.object({
  host: boundary.nonEmptyString,
  wait: boundary.optional(boundary.boolean),
  timeoutMs: boundary.optional(boundary.number),
});

const runBodySchema = boundary.object({ dryRun: boundary.optional(boundary.boolean) });

export interface CoordinatorApi {
  status(host: string): Promise<WakeResult>;
  wake(host: string, request: { wait: boolean; timeoutMs?: number }): Promise<WakeResult>;
  reconcile(options: { dryRun?: boolean }): Promise<ReconcileReport>;
  idleCheck(options: { dryRun?: boolean }): Promise<IdleCheckReport>;
}

export interface CoordinatorServerOptions {
  api: CoordinatorApi;
  directory: SessionDirectory;
  alerts: AlertSink;
  clock: Clock;
  secret: string;
  revokedCallers: readonly string[];
  version: string;
  log?: (line: string) => void;
}

const FAILURE_STATUS: Record<WakeFailureCode, number> = {
  'unknown-host': 404,
  'directory-unreadable': 503,
  'runaway-guard': 429,
  'wake-rate-limited': 429,
  'provider-error': 502,
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function createCoordinatorServer(options: CoordinatorServerOptions): http.Server {
  const peerWindows = new Map<string, number[]>();
  const log = options.log ?? ((line: string) => console.log(line));

  const rateLimitPeer = (caller: Caller): void => {
    if (caller.role !== 'peer') return;
    const now = options.clock.now();
    const recent = (peerWindows.get(caller.id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PEER_REQUESTS_PER_MINUTE) {
      throw new HttpError(429, 'rate-limited', `caller ${caller.id} exceeded ${PEER_REQUESTS_PER_MINUTE} requests per minute`);
    }
    recent.push(now);
    peerWindows.set(caller.id, recent);
  };

  const requireUser = (caller: Caller): void => {
    if (caller.role !== 'user') throw new HttpError(403, 'forbidden', 'this endpoint is only for user callers');
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://coordinator.invalid');
    if (url.pathname === '/health' && request.method === 'GET') {
      writeJson(response, 200, { ok: true, service: 'runpane-cloud-coordinator', version: options.version });
      return;
    }
    if (!url.pathname.startsWith('/cloud/')) throw new HttpError(404, 'not-found', `no endpoint ${url.pathname}`);

    const auth = await authenticateCaller(request.headers.authorization, {
      secret: options.secret,
      revokedCallers: options.revokedCallers,
      isKnownPeer: async (callerId) => {
        const directory = await options.directory.read();
        return directory.ok && directory.entries.some((entry) => entry.sessionId === callerId);
      },
    });
    if (!auth.ok) throw new HttpError(auth.status, auth.code, auth.message);
    const { caller } = auth;
    rateLimitPeer(caller);

    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    switch (route) {
      case 'GET /cloud/status': {
        const host = url.searchParams.get('host') ?? '';
        if (!host) throw new HttpError(400, 'bad-request', 'host query parameter is required');
        writeWakeResult(response, await options.api.status(host));
        return;
      }
      case 'POST /cloud/wake': {
        const body = decodeBoundary(await readJson(request), wakeBodySchema);
        log(`[coordinator] wake ${body.host} requested by ${caller.id}`);
        writeWakeResult(response, await options.api.wake(body.host, { wait: body.wait ?? true, timeoutMs: body.timeoutMs }));
        return;
      }
      case 'GET /cloud/alerts': {
        requireUser(caller);
        const limit = Number(url.searchParams.get('limit') ?? '50');
        writeJson(response, 200, { ok: true, alerts: options.alerts.recent(Number.isFinite(limit) ? limit : 50) });
        return;
      }
      case 'POST /cloud/reconcile': {
        requireUser(caller);
        const body = decodeBoundary(await readJson(request), runBodySchema);
        writeJson(response, 200, { ok: true, report: await options.api.reconcile({ dryRun: body.dryRun }) });
        return;
      }
      case 'POST /cloud/idle-check': {
        requireUser(caller);
        const body = decodeBoundary(await readJson(request), runBodySchema);
        writeJson(response, 200, { ok: true, report: await options.api.idleCheck({ dryRun: body.dryRun }) });
        return;
      }
      default:
        throw new HttpError(404, 'not-found', `no endpoint ${route}`);
    }
  };

  return http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        writeJson(response, error.status, { ok: false, code: error.code, message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const badInput = error instanceof SyntaxError || (error instanceof Error && error.name === 'BoundaryDecodeError');
      writeJson(response, badInput ? 400 : 500, { ok: false, code: badInput ? 'bad-request' : 'internal', message });
    });
  });
}

function writeWakeResult(response: ServerResponse, result: WakeResult): void {
  writeJson(response, result.ok ? 200 : FAILURE_STATUS[result.code], result);
}

function writeJson(response: ServerResponse, status: number, body: object): void {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(text);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', 'request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length === 0 ? {} : JSON.parse(text);
}
