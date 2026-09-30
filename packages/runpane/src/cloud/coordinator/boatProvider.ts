import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { CoordinatorProvider, ProviderSandbox, ProviderSandboxState } from './types';

// Minimal boat.dev client for the coordinator. It needs only sandbox.read, sandbox.stop and sandbox.resume,
// which is exactly what the coordinator's scoped key grants. There is deliberately no delete here.

const sandboxSchema = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.optional(boundary.nullable(boundary.string)),
  state: boundary.string,
  createdAt: boundary.optional(boundary.nullable(boundary.string)),
  updatedAt: boundary.optional(boundary.nullable(boundary.string)),
});

const listSchema = boundary.object({
  sandboxes: boundary.array(sandboxSchema),
  pageInfo: boundary.optional(boundary.nullable(boundary.object({
    nextCursor: boundary.optional(boundary.nullable(boundary.string)),
  }))),
});

const infoSchema = boundary.object({ sandbox: sandboxSchema });

export function mapBoatState(state: string): ProviderSandboxState {
  switch (state) {
    case 'init':
    case 'provisioning':
    case 'provisioned':
    case 'cloning':
      return 'starting';
    case 'ready':
    case 'idle':
    case 'running':
      return 'running';
    case 'archiving':
      return 'stopping';
    case 'archived':
      return 'stopped';
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      return 'failed';
  }
}

function toProviderSandbox(raw: {
  id: string;
  name?: string | null;
  state: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}): ProviderSandbox {
  return {
    id: raw.id,
    name: raw.name ?? '',
    state: mapBoatState(raw.state),
    rawState: raw.state,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export class BoatProviderError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'BoatProviderError';
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface BoatProviderOptions {
  apiBase: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

export class BoatCoordinatorProvider implements CoordinatorProvider {
  readonly kind = 'boat';
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: BoatProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async list(): Promise<ProviderSandbox[]> {
    const result: ProviderSandbox[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const body = await this.request('GET', `/sandboxes?${query.toString()}`);
      const decoded = decodeBoundary(body, listSchema);
      result.push(...decoded.sandboxes.map(toProviderSandbox));
      cursor = decoded.pageInfo?.nextCursor ?? null;
      if (!cursor) return result;
    }
    throw new BoatProviderError('boat sandbox list did not finish after 50 pages', 0, 'pagination');
  }

  async get(sandboxId: string): Promise<ProviderSandbox> {
    try {
      const body = await this.request('GET', `/sandboxes/${encodeURIComponent(sandboxId)}`);
      return toProviderSandbox(decodeBoundary(body, infoSchema).sandbox);
    } catch (error) {
      if (error instanceof BoatProviderError && error.status === 404) {
        return { id: sandboxId, name: '', state: 'missing', rawState: 'not_found', createdAt: null, updatedAt: null };
      }
      throw error;
    }
  }

  async stop(sandboxId: string): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/stop`, {});
  }

  async resume(sandboxId: string, idempotencyKey: string): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/resume`, {}, idempotencyKey);
  }

  private async request(method: string, pathAndQuery: string, body?: object, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await this.fetchImpl(`${this.options.apiBase}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = readErrorCode(parsed);
      throw new BoatProviderError(
        `boat ${method} ${pathAndQuery.split('?')[0]} failed: HTTP ${response.status}${code ? ` (${code})` : ''}`,
        response.status,
        code,
      );
    }
    return parsed;
  }
}

function readErrorCode(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return null;
  const error = parsed.error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}
