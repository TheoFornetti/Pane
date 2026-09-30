// Tailscale admin API client for `runpane cloud`, authenticated with an OAuth client
// (client-credentials grant). It mints single-use tagged auth keys for new cloud sandboxes
// and lists or deletes their devices. Secrets (client secret, access token, auth keys) never
// appear in errors or logs.

const DEFAULT_API_BASE = 'https://api.tailscale.com/api/v2';

export const CLOUD_SESSION_TAG = 'tag:rp-session';

export interface TailscaleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Tailnet name; "-" (the default) means the OAuth client's own tailnet. */
  tailnet?: string;
}

export interface MintAuthKeyOptions {
  tags?: string[];
  reusable?: boolean;
  ephemeral?: boolean;
  preauthorized?: boolean;
  expirySeconds?: number;
  description?: string;
}

export interface TailscaleAuthKey {
  id: string;
  /** The secret key. Callers hand it to the sandbox through a 0600 file and never print it. */
  key: string;
  expires?: string;
}

export interface TailscaleDevice {
  /** Stable node id ("n…CNTRL"). */
  nodeId: string;
  /** Legacy numeric id. */
  id: string;
  hostname: string;
  /** MagicDNS FQDN without the trailing dot. */
  name: string;
  addresses: string[];
  tags: string[];
  lastSeen?: string;
}

export interface TailscaleApi {
  mintAuthKey(options?: MintAuthKeyOptions): Promise<TailscaleAuthKey>;
  listDevices(): Promise<TailscaleDevice[]>;
  /** Devices whose OS hostname or MagicDNS short name equals `hostname`. */
  findDevicesByHostname(hostname: string): Promise<TailscaleDevice[]>;
  /** Deletes a device by node id. Resolves false when it was already gone (404). */
  deleteDevice(nodeId: string): Promise<boolean>;
}

export class TailscaleApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TailscaleApiError';
  }
}

type FetchLike = typeof fetch;

interface CachedToken {
  header: string;
  expiresAt: number;
}

export function createTailscaleApi(
  credentials: TailscaleOAuthCredentials,
  fetchImpl: FetchLike = fetch,
  apiBase = DEFAULT_API_BASE,
): TailscaleApi {
  const tailnet = encodeURIComponent(credentials.tailnet ?? '-');
  let cached: CachedToken | undefined;

  async function authorization(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.header;
    }
    const body = new URLSearchParams({
      client_id: credentials.clientId.trim(),
      client_secret: credentials.clientSecret.trim(),
      grant_type: 'client_credentials',
    });
    const response = await fetchImpl(`${apiBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new TailscaleApiError(`Tailscale OAuth token request failed (HTTP ${response.status})`, response.status);
    }
    const payload = asRecord(await response.json());
    const token = typeof payload.access_token === 'string' ? payload.access_token : '';
    if (!token) {
      throw new TailscaleApiError('Tailscale OAuth token response had no access_token');
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    cached = { header: `Bearer ${token}`, expiresAt: Date.now() + expiresIn * 1000 };
    return cached.header;
  }

  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: await authorization() };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function failure(response: Response, what: string): Promise<TailscaleApiError> {
    let detail = '';
    try {
      const payload = asRecord(await response.json());
      detail = typeof payload.message === 'string' ? `: ${payload.message}` : '';
    } catch {
      // Error bodies are informational only.
    }
    return new TailscaleApiError(`${what} failed (HTTP ${response.status})${detail}`, response.status);
  }

  async function listDevices(): Promise<TailscaleDevice[]> {
    const response = await request('GET', `/tailnet/${tailnet}/devices`);
    if (!response.ok) {
      throw await failure(response, 'Tailscale device list');
    }
    const payload = asRecord(await response.json());
    const devices = Array.isArray(payload.devices) ? payload.devices : [];
    return devices.map((device) => parseDevice(asRecord(device)));
  }

  return {
    async mintAuthKey(options: MintAuthKeyOptions = {}): Promise<TailscaleAuthKey> {
      const tags = options.tags ?? [CLOUD_SESSION_TAG];
      if (tags.length === 0) {
        throw new TailscaleApiError('Cloud auth keys must carry at least one tag');
      }
      const response = await request('POST', `/tailnet/${tailnet}/keys`, {
        capabilities: {
          devices: {
            create: {
              reusable: options.reusable ?? false,
              ephemeral: options.ephemeral ?? false,
              preauthorized: options.preauthorized ?? true,
              tags,
            },
          },
        },
        expirySeconds: options.expirySeconds ?? 600,
        description: (options.description ?? 'runpane cloud').slice(0, 50),
      });
      if (!response.ok) {
        throw await failure(response, 'Tailscale auth key mint');
      }
      const payload = asRecord(await response.json());
      if (typeof payload.key !== 'string' || typeof payload.id !== 'string') {
        throw new TailscaleApiError('Tailscale auth key response had no key');
      }
      return {
        id: payload.id,
        key: payload.key,
        expires: typeof payload.expires === 'string' ? payload.expires : undefined,
      };
    },

    listDevices,

    async findDevicesByHostname(hostname: string): Promise<TailscaleDevice[]> {
      const wanted = hostname.toLowerCase();
      return (await listDevices()).filter((device) =>
        device.hostname.toLowerCase() === wanted || device.name.toLowerCase().split('.')[0] === wanted);
    },

    async deleteDevice(nodeId: string): Promise<boolean> {
      const response = await request('DELETE', `/device/${encodeURIComponent(nodeId)}`);
      if (response.status === 404) {
        return false;
      }
      if (!response.ok) {
        throw await failure(response, `Tailscale device delete ${nodeId}`);
      }
      return true;
    },
  };
}

function parseDevice(record: Record<string, unknown>): TailscaleDevice {
  return {
    nodeId: stringField(record.nodeId),
    id: stringField(record.id),
    hostname: stringField(record.hostname),
    name: stringField(record.name).replace(/\.$/, ''),
    addresses: stringArray(record.addresses),
    tags: stringArray(record.tags),
    lastSeen: typeof record.lastSeen === 'string' ? record.lastSeen : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
