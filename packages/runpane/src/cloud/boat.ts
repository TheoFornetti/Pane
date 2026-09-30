import { randomBytes } from 'node:crypto';
import {
  CloudProviderError,
  type CloudProvider,
  type CloudSandbox,
  type CloudSandboxState,
  type CloudSize,
  type CreateSandboxRequest,
  type SandboxCommandResult,
  type SandboxHandle,
} from './provider';

/**
 * boat.dev REST adapter (OpenAPI: https://boat.dev/api/v1). Gotchas it encodes, all seen live in M0:
 * - create has no name field, so a create is followed by PATCH { name };
 * - DELETE needs `X-Ascii-Confirm-Delete: <sandboxId>`;
 * - POST /commands takes one command string and caps a synchronous run at 600 s, so scripts are
 *   uploaded with PUT /files and run as `bash <file>`;
 * - `idle` means ready; `archived` means stopped.
 */

export const BOAT_API_BASE_URL = 'https://boat.dev/api/v1';
const MAX_COMMAND_TIMEOUT_SECONDS = 600;
const SCRIPT_DIR = '/home/user/.runpane-cloud';
const RETRY_DELAYS_MS = [500, 1_500, 4_000];

export interface BoatProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type JsonRecord = Record<string, unknown>;

interface BoatRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: JsonRecord;
  headers?: Record<string, string>;
  /** Safe to resend: reads, and creates carrying an Idempotency-Key. */
  retry?: boolean;
}

interface BoatResponse {
  status: number;
  body: JsonRecord;
}

export function createBoatProvider(options: BoatProviderOptions): CloudProvider {
  const baseUrl = (options.baseUrl ?? BOAT_API_BASE_URL).replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(request: BoatRequest): Promise<BoatResponse> {
    const attempts = request.retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 4_000);
      try {
        const response = await fetchImpl(`${baseUrl}${request.path}`, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: 'application/json',
            ...(request.body ? { 'Content-Type': 'application/json' } : {}),
            ...request.headers,
          },
          body: request.body ? JSON.stringify(request.body) : undefined,
        });
        const text = await response.text();
        const body = parseJsonRecord(text);
        if (response.status >= 500 && attempt < attempts - 1) {
          lastError = boatError(request, response.status, body);
          continue;
        }
        return { status: response.status, body };
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1) break;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`boat ${request.method} ${request.path} failed`);
  }

  async function call(request: BoatRequest, okStatuses: readonly number[] = [200, 201, 202]): Promise<JsonRecord> {
    const response = await send(request);
    if (!okStatuses.includes(response.status)) throw boatError(request, response.status, response.body);
    return response.body;
  }

  async function getSandbox(sandboxId: string): Promise<CloudSandbox> {
    const response = await send({ method: 'GET', path: `/sandboxes/${encodeId(sandboxId)}`, retry: true });
    if (response.status === 404) return goneSandbox(sandboxId);
    if (response.status !== 200) throw boatError({ method: 'GET', path: `/sandboxes/${sandboxId}` }, response.status, response.body);
    return toCloudSandbox(sandboxRecord(response.body));
  }

  function handle(sandboxId: string): SandboxHandle {
    const writeFile = async (path: string, content: string): Promise<void> => {
      await call({
        method: 'PUT',
        path: `/sandboxes/${encodeId(sandboxId)}/files`,
        body: { path, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
      });
    };
    return {
      id: sandboxId,
      writeFile,
      async runScript(script, runOptions): Promise<SandboxCommandResult> {
        const timeoutSeconds = Math.min(
          Math.max(1, Math.floor(runOptions?.timeoutSeconds ?? MAX_COMMAND_TIMEOUT_SECONDS)),
          MAX_COMMAND_TIMEOUT_SECONDS,
        );
        const file = `${SCRIPT_DIR}/run-${randomBytes(6).toString('hex')}.sh`;
        await writeFile(file, script);
        const body = await call({
          method: 'POST',
          path: `/sandboxes/${encodeId(sandboxId)}/commands`,
          body: { command: `bash ${file}; rc=$?; rm -f ${file}; exit $rc`, timeoutSeconds },
        });
        const result = isRecord(body.result) ? body.result : body;
        return {
          exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
          stdout: typeof result.stdout === 'string' ? result.stdout : '',
          stderr: typeof result.stderr === 'string' ? result.stderr : '',
          timedOut: result.timedOut === true,
        };
      },
    };
  }

  return {
    name: 'boat',
    async verifyCredentials() {
      const body = await call({ method: 'GET', path: '/me', retry: true });
      const user = isRecord(body.user) ? body.user : body;
      const account = [user.email, user.username, user.id].find((value): value is string => typeof value === 'string');
      return { account: account ?? 'boat account' };
    },
    async create(request: CreateSandboxRequest) {
      const body: JsonRecord = { type: request.size, ttlSeconds: null, noEnv: true };
      if (request.fromSnapshot) body.from = request.fromSnapshot;
      const created = await call({
        method: 'POST',
        path: '/sandboxes',
        body,
        headers: { 'Idempotency-Key': request.idempotencyKey },
        retry: true,
      });
      const sandbox = toCloudSandbox(sandboxRecord(created));
      if (sandbox.name !== request.name) {
        await call({ method: 'PATCH', path: `/sandboxes/${encodeId(sandbox.id)}`, body: { name: request.name } });
      }
      return { ...sandbox, name: request.name };
    },
    get: getSandbox,
    async list() {
      const sandboxes: CloudSandbox[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
        const body = await call({ method: 'GET', path: `/sandboxes${query}`, retry: true });
        const items = Array.isArray(body.sandboxes) ? body.sandboxes : [];
        for (const item of items) {
          if (isRecord(item)) sandboxes.push(toCloudSandbox(item));
        }
        const next = body.nextCursor ?? body.cursor;
        if (typeof next !== 'string' || next.length === 0 || items.length === 0) break;
        cursor = next;
      }
      return sandboxes;
    },
    async rename(sandboxId, name) {
      await call({ method: 'PATCH', path: `/sandboxes/${encodeId(sandboxId)}`, body: { name } });
    },
    async stop(sandboxId) {
      await call({ method: 'POST', path: `/sandboxes/${encodeId(sandboxId)}/stop`, body: {} });
    },
    async resume(sandboxId, resumeOptions) {
      const body: JsonRecord = {};
      if (resumeOptions?.size) body.type = resumeOptions.size;
      await call({ method: 'POST', path: `/sandboxes/${encodeId(sandboxId)}/resume`, body });
    },
    async destroy(sandboxId) {
      await call(
        {
          method: 'DELETE',
          path: `/sandboxes/${encodeId(sandboxId)}`,
          headers: { 'X-Ascii-Confirm-Delete': sandboxId },
        },
        [200, 202, 204, 404],
      );
    },
    handle,
  };
}

const STATE_MAP: Record<string, CloudSandboxState> = {
  init: 'starting',
  provisioning: 'starting',
  provisioned: 'starting',
  cloning: 'starting',
  ready: 'running',
  idle: 'running',
  running: 'running',
  archiving: 'stopping',
  archived: 'stopped',
  error: 'error',
  cancelled: 'error',
};

export function toCloudSandbox(record: JsonRecord): CloudSandbox {
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) throw new Error('boat returned a sandbox without an id');
  const providerState = typeof record.state === 'string' ? record.state : 'unknown';
  const size = record.type === 'small' || record.type === 'default' || record.type === 'large' ? record.type : undefined;
  return {
    id,
    name: typeof record.name === 'string' ? record.name : '',
    state: STATE_MAP[providerState] ?? 'error',
    providerState,
    size: size satisfies CloudSize | undefined,
    error: typeof record.error === 'string' ? record.error : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
  };
}

function goneSandbox(sandboxId: string): CloudSandbox {
  return { id: sandboxId, name: '', state: 'gone', providerState: 'not_found' };
}

function sandboxRecord(body: JsonRecord): JsonRecord {
  return isRecord(body.sandbox) ? body.sandbox : body;
}

function boatError(request: Pick<BoatRequest, 'method' | 'path'>, status: number, body: JsonRecord): CloudProviderError {
  const nested = isRecord(body.error) ? body.error : {};
  const code = typeof body.code === 'string' ? body.code : typeof nested.code === 'string' ? nested.code : undefined;
  const message = typeof body.message === 'string' ? body.message : typeof nested.message === 'string' ? nested.message : '';
  const pathOnly = request.path.split('?')[0];
  return new CloudProviderError(
    `boat ${request.method} ${pathOnly} failed with HTTP ${status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`,
    status,
    code,
  );
}

function parseJsonRecord(text: string): JsonRecord {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeId(sandboxId: string): string {
  return encodeURIComponent(sandboxId);
}
