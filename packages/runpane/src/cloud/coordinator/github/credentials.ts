import type { KeyObject } from 'node:crypto';
import { boundary, decodeBoundary } from '../../../boundaryDecoder';
import type { BoundarySchema } from '../../../boundaryDecoder';
import type { Clock } from '../types';
import { BrokerError } from './policy';
import { appJwt, loadAppPrivateKey } from './rest';
import type { GitHubRest } from './rest';

// Where the broker's GitHub credential comes from (phase3-design.md §2). Both are the user's own:
// a GitHub App (private key on the coordinator; 1 h installation tokens minted per call, narrowed to
// one repository and the permissions that call needs) or a fine-grained PAT. Tokens live in memory only.

type Level = 'read' | 'write';
export type PermissionName = 'contents' | 'issues' | 'pull_requests' | 'metadata' | 'checks' | 'statuses' | 'actions';
export type Permissions = Partial<Record<PermissionName, Level>>;

export interface RepoToken {
  token: string;
  /** ISO time; null for a PAT (its expiry is GitHub's business). */
  expiresAt: string | null;
}

export interface CredentialStatus {
  mode: 'app' | 'pat';
  app: { id: string; slug: string | null; installationIds: number[] } | null;
  /** Repositories the credential can reach, when GitHub can list them (App mode). */
  repos: string[] | null;
}

export interface CachedTokenInfo {
  repo: string;
  access: Level;
  expiresAt: string | null;
}

export interface GitHubCredential {
  readonly mode: 'app' | 'pat';
  /** A token for one repository with (at most) these permissions. */
  token(repo: string, permissions: Permissions): Promise<RepoToken>;
  describe(): Promise<CredentialStatus>;
  cachedTokens(): CachedTokenInfo[];
}

/** Reuse a cached installation token until 5 minutes before it expires (design §3). */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const INSTALLATION_CACHE_MS = 10 * 60_000;

const installationSchema = boundary.object({
  id: boundary.number,
  permissions: boundary.optional(boundary.jsonObject),
});
const accessTokenSchema = boundary.object({ token: boundary.nonEmptyString, expires_at: boundary.nonEmptyString });
const appSchema = boundary.object({ slug: boundary.optional(boundary.string) });
const installationListSchema = boundary.array(boundary.object({ id: boundary.number }));
const repositoriesSchema = boundary.object({ repositories: boundary.array(boundary.object({ full_name: boundary.nonEmptyString })) });

interface Installation {
  id: number;
  granted: Permissions;
  fetchedAt: number;
}

function decodeGitHub<Value>(value: unknown, schema: BoundarySchema<Value>, what: string): Value {
  try {
    return decodeBoundary(value, schema);
  } catch (cause) {
    throw new BrokerError('github-error', `GitHub returned an unexpected ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { status: 200, message: 'unexpected body' });
  }
}

function accessOf(permissions: Permissions): Level {
  return Object.values(permissions).includes('write') ? 'write' : 'read';
}

function permissionKey(repo: string, permissions: Permissions): string {
  return `${repo.toLowerCase()}|${Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)).map(([name, level]) => `${name}:${level}`).join(',')}`;
}

/**
 * What the installation was granted bounds what a token may ask for (GitHub answers 422 otherwise).
 * A permission the call needs but the App lacks is refused here, so a token is never minted with
 * less than the call needs, nor ever with an empty permission set (which GitHub reads as "all").
 */
function narrow(requested: Permissions, granted: Permissions): Permissions {
  const result: Permissions = { metadata: 'read' };
  for (const [name, level] of Object.entries(requested) as Array<[PermissionName, Level]>) {
    if (name === 'metadata') continue;
    const has = granted[name];
    if (!has || (level === 'write' && has !== 'write')) {
      throw new BrokerError('github-error', `the GitHub App installation lacks the "${name}: ${level}" permission this call needs`, { status: 403, message: `missing ${name}:${level}` });
    }
    result[name] = level;
  }
  return result;
}

export class GitHubAppCredential implements GitHubCredential {
  readonly mode = 'app' as const;
  private readonly key: KeyObject;
  private readonly installations = new Map<string, Installation>();
  private readonly tokens = new Map<string, { repo: string; access: Level; token: string; expiresAt: string }>();
  private slug: string | null = null;

  constructor(
    private readonly options: { appId: string; privateKeyPem: string; installationId: number | null },
    private readonly rest: GitHubRest,
    private readonly clock: Clock,
  ) {
    if (!/^\d{1,12}$/u.test(options.appId)) throw new Error('the GitHub App id must be a number');
    this.key = loadAppPrivateKey(options.privateKeyPem);
  }

  private jwt(): string {
    return appJwt(this.options.appId, this.key, this.clock.now());
  }

  private async installationFor(repo: string): Promise<Installation> {
    const cached = this.installations.get(repo.toLowerCase());
    if (cached && this.clock.now() - cached.fetchedAt < INSTALLATION_CACHE_MS) return cached;
    let response;
    try {
      response = await this.rest.request('GET', `/repos/${repo}/installation`, this.jwt());
    } catch (cause) {
      if (cause instanceof BrokerError && cause.github?.status === 404) {
        throw new BrokerError('repo-not-allowed', `the GitHub App is not installed on ${repo}`);
      }
      throw cause;
    }
    const decoded = decodeGitHub(response.body, installationSchema, 'installation');
    if (this.options.installationId !== null && decoded.id !== this.options.installationId) {
      throw new BrokerError('repo-not-allowed', `${repo} belongs to installation ${decoded.id}, not the configured ${this.options.installationId}`);
    }
    const granted: Permissions = {};
    for (const [name, level] of Object.entries(decoded.permissions ?? {})) {
      if (level === 'read' || level === 'write') granted[name as PermissionName] = level;
    }
    const installation = { id: decoded.id, granted, fetchedAt: this.clock.now() };
    this.installations.set(repo.toLowerCase(), installation);
    return installation;
  }

  async token(repo: string, permissions: Permissions): Promise<RepoToken> {
    const installation = await this.installationFor(repo);
    const wanted = narrow(permissions, installation.granted);
    const cacheKey = permissionKey(repo, wanted);
    const cached = this.tokens.get(cacheKey);
    if (cached && Date.parse(cached.expiresAt) - TOKEN_REUSE_MARGIN_MS > this.clock.now()) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
    const response = await this.rest.request('POST', `/app/installations/${installation.id}/access_tokens`, this.jwt(), {
      repositories: [repo.split('/')[1]],
      permissions: wanted,
    });
    const minted = decodeGitHub(response.body, accessTokenSchema, 'installation token');
    this.tokens.set(cacheKey, { repo, access: accessOf(wanted), token: minted.token, expiresAt: minted.expires_at });
    return { token: minted.token, expiresAt: minted.expires_at };
  }

  cachedTokens(): CachedTokenInfo[] {
    const now = this.clock.now();
    return [...this.tokens.values()]
      .filter((entry) => Date.parse(entry.expiresAt) > now)
      .map(({ repo, access, expiresAt }) => ({ repo, access, expiresAt }));
  }

  async describe(): Promise<CredentialStatus> {
    if (this.slug === null) {
      this.slug = decodeGitHub((await this.rest.request('GET', '/app', this.jwt())).body, appSchema, 'app').slug ?? null;
    }
    const installationIds = this.options.installationId !== null
      ? [this.options.installationId]
      : decodeGitHub((await this.rest.request('GET', '/app/installations?per_page=100', this.jwt())).body, installationListSchema, 'installation list').map((item) => item.id);
    const repos: string[] = [];
    for (const id of installationIds) {
      // A metadata-only token over the whole installation, just to list its repositories.
      const minted = decodeGitHub((await this.rest.request('POST', `/app/installations/${id}/access_tokens`, this.jwt(), { permissions: { metadata: 'read' } })).body, accessTokenSchema, 'installation token');
      const listed = decodeGitHub((await this.rest.request('GET', '/installation/repositories?per_page=100', minted.token)).body, repositoriesSchema, 'repository list');
      repos.push(...listed.repositories.map((repo) => repo.full_name));
    }
    return { mode: 'app', app: { id: this.options.appId, slug: this.slug, installationIds }, repos };
  }
}

/** Token prefixes of credentials that reach every repository the user can: never accepted. */
const BROAD_TOKEN_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];

/** Throws unless `token` looks like a fine-grained PAT (`github_pat_…`). Never includes the token in the message. */
export function assertFineGrainedPat(token: string): void {
  const broad = BROAD_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix));
  if (broad) {
    throw new Error(`refusing a ${broad}… token: classic and OAuth tokens reach every repository you can. Create a fine-grained PAT (github_pat_…) for the selected repositories only.`);
  }
  if (!token.startsWith('github_pat_')) throw new Error('the PAT must be a fine-grained personal access token (github_pat_…)');
  if (/\s/u.test(token)) throw new Error('the PAT file must hold only the token');
}

export class GitHubPatCredential implements GitHubCredential {
  readonly mode = 'pat' as const;

  constructor(private readonly pat: string) {
    assertFineGrainedPat(pat);
  }

  async token(): Promise<RepoToken> {
    return { token: this.pat, expiresAt: null };
  }

  async describe(): Promise<CredentialStatus> {
    return { mode: 'pat', app: null, repos: null };
  }

  cachedTokens(): CachedTokenInfo[] {
    return [];
  }
}
