import { createPrivateKey, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { JsonValue } from '../../../boundaryDecoder';
import { BrokerError } from './policy';

// A minimal GitHub REST client for the coordinator (no npm dependencies). The base URL is
// configurable so tests and the live proof can point it at a fake GitHub.

const TIMEOUT_MS = 30_000;

export interface GitHubResponse {
  status: number;
  body: JsonValue | undefined;
}

export type GitHubMethod = 'GET' | 'POST' | 'PATCH';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface GitHubRest {
  /** Resolves only 2xx answers; throws BrokerError github-error / github-rate-limited otherwise. */
  request(method: GitHubMethod, route: string, auth: string, body?: JsonValue): Promise<GitHubResponse>;
}

export function createGitHubRest(apiBaseUrl: string, fetchImpl: FetchLike = fetch): GitHubRest {
  const base = apiBaseUrl.replace(/\/+$/u, '');
  return {
    async request(method, route, auth, body) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${auth}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'runpane-cloud-coordinator',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try {
        response = await fetchImpl(`${base}${route}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new BrokerError('github-error', `GitHub ${method} ${routeLabel(route)} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { status: 0, message: 'unreachable' });
      }
      const text = await response.text();
      let parsed: JsonValue | undefined;
      try {
        parsed = text ? (JSON.parse(text) as JsonValue) : undefined;
      } catch {
        parsed = undefined;
      }
      if (response.status >= 200 && response.status < 300) return { status: response.status, body: parsed };
      const message = messageOf(parsed) ?? `HTTP ${response.status}`;
      const rateLimited = response.status === 429
        || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/iu.test(message)));
      throw new BrokerError(
        rateLimited ? 'github-rate-limited' : 'github-error',
        `GitHub ${method} ${routeLabel(route)} answered ${response.status}: ${message}`,
        { status: response.status, message },
      );
    },
  };
}

/** The route without its query string, for messages and the audit log. */
function routeLabel(route: string): string {
  return route.split('?')[0];
}

function messageOf(body: JsonValue | undefined): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.message === 'string') {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const details = errors.map((error) => (error && typeof error === 'object' && !Array.isArray(error) && typeof error.message === 'string' ? error.message : '')).filter(Boolean);
    return details.length > 0 ? `${body.message} (${details.join('; ')})` : body.message;
  }
  return null;
}

// ---------------------------------------------------------------- GitHub App JWT (RS256)

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

export function loadAppPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('the GitHub App private key must be an RSA key (.pem from the App settings)');
  return key;
}

/**
 * The App's own JWT (GitHub: "Authenticating as a GitHub App"): RS256, `iss` = App id, issued 60 s
 * in the past against clock drift, valid for 9 minutes (GitHub allows at most 10).
 */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}
