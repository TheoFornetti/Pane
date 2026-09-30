import type { JsonObject, JsonValue } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { assertFineGrainedPat } from './coordinator/github/credentials';
import { appJwt, createGitHubRest, loadAppPrivateKey } from './coordinator/github/rest';
import { loadCoordinatorProvider, reconfigureCoordinator, requireCoordinatorDeployment, saveCoordinatorDeployment } from './coordinatorDeploy';
import type { CoordinatorDeployment, CoordinatorGitHub } from './store';

/**
 * `runpane cloud coordinator github set|status|audit|unset`, run on the user's machine at setup time
 * (phase3-design.md §5). `set` checks the credential, uploads it to the coordinator through the
 * provider's files API (0600 there, never on a command line or in this machine's settings), rewrites
 * the coordinator config and restarts it, then asks the coordinator's broker whether it loaded.
 */

export const COORDINATOR_GITHUB_USAGE = `GitHub broker on the coordinator (Sessions push, open PRs and issues through it; no laptop at runtime):
  runpane cloud coordinator github set --app-id <id> --private-key-file <pem|-> [--installation-id <id>]
        [--allow-ready-pulls] [--api-base-url <url> --git-base-url <url>] [--no-verify] [--json]
  runpane cloud coordinator github set --pat-file <file|-> [--repo <owner/name>]... [--allow-ready-pulls] [--no-verify] [--json]
  runpane cloud coordinator github status [--json]
  runpane cloud coordinator github audit [--limit <n>] [--json]
  runpane cloud coordinator github unset --yes [--json]`;

interface GitHubArgs {
  sub: 'set' | 'status' | 'audit' | 'unset';
  json: boolean;
  yes: boolean;
  appId?: string;
  privateKeyFile?: string;
  installationId?: number;
  patFile?: string;
  repos: string[];
  allowReadyPulls?: boolean;
  apiBaseUrl?: string;
  gitBaseUrl?: string;
  verify: boolean;
  limit: number;
}

export function parseCoordinatorGitHubArgs(argv: readonly string[]): GitHubArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'set' && sub !== 'status' && sub !== 'audit' && sub !== 'unset') throw new Error(COORDINATOR_GITHUB_USAGE);
  const args: GitHubArgs = { sub, json: false, yes: false, repos: [], verify: true, limit: 50 };
  const value = (index: number, flag: string): string => {
    const next = rest[index + 1];
    if (next === undefined || (next.startsWith('--') && next !== '-')) throw new Error(`${flag} requires a value.`);
    return next;
  };
  const only = (flag: string, ...subs: GitHubArgs['sub'][]) => {
    if (!subs.includes(sub)) throw new Error(`Unknown option for runpane cloud coordinator github ${sub}: ${flag}`);
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    switch (flag) {
      case '--json': args.json = true; break;
      case '--yes': case '-y': args.yes = true; break;
      case '--app-id': only(flag, 'set'); args.appId = value(index++, flag); break;
      case '--private-key-file': only(flag, 'set'); args.privateKeyFile = value(index++, flag); break;
      case '--installation-id': {
        only(flag, 'set');
        const raw = value(index++, flag);
        if (!/^\d{1,12}$/u.test(raw)) throw new Error('--installation-id must be a number.');
        args.installationId = Number(raw);
        break;
      }
      case '--pat-file': only(flag, 'set'); args.patFile = value(index++, flag); break;
      case '--repo': {
        only(flag, 'set');
        const repo = value(index++, flag);
        if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repo)) throw new Error('--repo must be owner/name.');
        args.repos.push(repo);
        break;
      }
      case '--allow-ready-pulls': only(flag, 'set'); args.allowReadyPulls = true; break;
      case '--no-allow-ready-pulls': only(flag, 'set'); args.allowReadyPulls = false; break;
      case '--api-base-url': only(flag, 'set'); args.apiBaseUrl = value(index++, flag); break;
      case '--git-base-url': only(flag, 'set'); args.gitBaseUrl = value(index++, flag); break;
      case '--no-verify': only(flag, 'set'); args.verify = false; break;
      case '--limit': {
        only(flag, 'audit');
        const limit = Number(value(index++, flag));
        if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error('--limit must be 1-1000.');
        args.limit = limit;
        break;
      }
      default: throw new Error(`Unknown option for runpane cloud coordinator github ${sub}: ${flag}\n\n${COORDINATOR_GITHUB_USAGE}`);
    }
  }
  if (sub === 'set') {
    const app = args.appId !== undefined || args.privateKeyFile !== undefined;
    if (app && args.patFile) throw new Error('Pass either --app-id/--private-key-file (GitHub App) or --pat-file (fine-grained PAT), not both.');
    if (!app && !args.patFile) throw new Error(`coordinator github set needs a credential.\n\n${COORDINATOR_GITHUB_USAGE}`);
    if (app && (!args.appId || !args.privateKeyFile)) throw new Error('A GitHub App needs both --app-id and --private-key-file.');
    if (args.appId !== undefined && !/^\d{1,12}$/u.test(args.appId)) throw new Error('--app-id must be the numeric App ID.');
    for (const [flag, url] of [['--api-base-url', args.apiBaseUrl], ['--git-base-url', args.gitBaseUrl]] as const) {
      if (url !== undefined && !/^https?:\/\/[^\s/]+/u.test(url)) throw new Error(`${flag} must be an http(s) URL.`);
    }
    if ((args.apiBaseUrl === undefined) !== (args.gitBaseUrl === undefined)) throw new Error('--api-base-url and --git-base-url go together (a fake GitHub serves both).');
  }
  return args;
}

export async function runCoordinatorGitHub(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const args = parseCoordinatorGitHubArgs(argv);
  switch (args.sub) {
    case 'set': return set(args, deps);
    case 'status': return status(args, deps);
    case 'audit': return audit(args, deps);
    case 'unset': return unset(args, deps);
  }
}

/** GitHub App permissions the broker must not hold: with them, GitHub stops backing up its refusals. */
const FORBIDDEN_APP_PERMISSIONS = ['workflows', 'administration', 'secrets', 'organization_administration'];

interface Verified {
  app: { slug: string | null; installationId: number; permissions: JsonObject } | null;
  repos: string[];
}

function objectOf(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayOf(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

async function verifyApp(args: GitHubArgs, pem: string): Promise<Verified> {
  const rest = createGitHubRest(args.apiBaseUrl ?? 'https://api.github.com');
  const key = loadAppPrivateKey(pem);
  // Wall-clock time: GitHub checks the JWT's iat/exp against its own clock.
  const jwt = () => appJwt(args.appId ?? '', key, Date.now());
  const app = objectOf((await rest.request('GET', '/app', jwt())).body);
  const installations = arrayOf((await rest.request('GET', '/app/installations?per_page=100', jwt())).body).map(objectOf);
  const chosen = args.installationId !== undefined
    ? installations.find((installation) => installation.id === args.installationId)
    : installations.length === 1 ? installations[0] : undefined;
  if (!chosen) {
    const ids = installations.map((installation) => String(installation.id)).join(', ') || 'none';
    throw new Error(args.installationId !== undefined
      ? `The App has no installation ${args.installationId} (installations: ${ids}).`
      : installations.length === 0
        ? 'The App is not installed anywhere yet: install it on the repositories Sessions should reach (Install App -> Only select repositories).'
        : `The App has several installations (${ids}); pass --installation-id.`);
  }
  const permissions = objectOf(chosen.permissions);
  const forbidden = FORBIDDEN_APP_PERMISSIONS.filter((name) => permissions[name] !== undefined);
  if (forbidden.length > 0) {
    throw new Error(`The App holds ${forbidden.join(', ')} permission(s). The broker needs only Contents, Issues and Pull requests (read and write) plus Metadata; remove the rest in the App settings, accept the new permissions on the installation, and rerun.`);
  }
  const installationId = Number(chosen.id);
  const token = objectOf((await rest.request('POST', `/app/installations/${installationId}/access_tokens`, jwt(), { permissions: { metadata: 'read' } })).body);
  const listed = objectOf((await rest.request('GET', '/installation/repositories?per_page=100', String(token.token ?? ''))).body);
  const repos = arrayOf(listed.repositories).map((repo) => String(objectOf(repo).full_name ?? '')).filter(Boolean);
  return { app: { slug: typeof app.slug === 'string' ? app.slug : null, installationId, permissions }, repos };
}

async function verifyPat(args: GitHubArgs, pat: string, deps: CloudDeps): Promise<Verified> {
  const rest = createGitHubRest(args.apiBaseUrl ?? 'https://api.github.com');
  await rest.request('GET', '/rate_limit', pat);
  const hosts = await deps.store.listHosts();
  const repos = [...new Set([...args.repos, ...hosts.flatMap((record) => record.meta.brokerRepos ?? [])])];
  for (const repo of repos) {
    const info = objectOf((await rest.request('GET', `/repos/${repo}`, pat)).body);
    if (objectOf(info.permissions).push !== true) throw new Error(`The PAT cannot write to ${repo}: give it Contents, Issues and Pull requests (read and write) on that repository.`);
  }
  return { app: null, repos };
}

async function set(args: GitHubArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireCoordinatorDeployment(deps);
  const mode = args.patFile ? 'pat' : 'app';
  const secretPath = (mode === 'app' ? args.privateKeyFile : args.patFile) ?? '';
  const secret = (await deps.readSecretFile(secretPath)).trim();
  if (mode === 'app') loadAppPrivateKey(secret);
  else assertFineGrainedPat(secret);

  const progress = (line: string) => (args.json ? deps.stderr(line) : deps.stdout(line));
  let verified: Verified | null = null;
  if (args.verify) {
    progress(`runpane cloud: checking the ${mode === 'app' ? 'GitHub App' : 'PAT'} with GitHub${args.apiBaseUrl ? ` at ${args.apiBaseUrl}` : ''}...`);
    verified = mode === 'app' ? await verifyApp(args, secret) : await verifyPat(args, secret, deps);
  }

  const github: CoordinatorGitHub = {
    mode,
    allowReadyPulls: args.allowReadyPulls ?? deployment.github?.allowReadyPulls ?? false,
    setAt: new Date(deps.now()).toISOString(),
  };
  if (mode === 'app') {
    github.appId = args.appId;
    const installationId = args.installationId ?? verified?.app?.installationId;
    if (installationId !== undefined) github.installationId = installationId;
  }
  if (args.apiBaseUrl) github.apiBaseUrl = args.apiBaseUrl;
  if (args.gitBaseUrl) github.gitBaseUrl = args.gitBaseUrl;
  const next: CoordinatorDeployment = { ...deployment, github };

  progress(`runpane cloud: installing the credential on the coordinator ${deployment.hostname} (0600) and restarting it...`);
  const { provider } = await loadCoordinatorProvider(deps);
  await reconfigureCoordinator(provider, next, { githubCredential: { file: mode === 'app' ? 'app.pem' : 'pat', content: `${secret}\n` } });
  await saveCoordinatorDeployment(deps, next);

  const broker = await brokerStatus(deps);
  const brokerError = broker && typeof broker.error === 'string' ? broker.error : null;
  const summary = {
    ok: broker !== null && brokerError === null,
    mode,
    appId: github.appId ?? null,
    installationId: github.installationId ?? null,
    allowReadyPulls: github.allowReadyPulls,
    verifiedWithGitHub: verified !== null,
    repos: verified?.repos ?? null,
    coordinator: broker,
  };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`runpane cloud: the coordinator's GitHub broker is on (${mode === 'app' ? `GitHub App ${github.appId}${verified?.app?.slug ? ` "${verified.app.slug}"` : ''}${github.installationId ? `, installation ${github.installationId}` : ''}` : 'fine-grained PAT'}).`);
    if (verified) deps.stdout(`  reaches: ${verified.repos.join(', ') || '(no repositories listed)'}`);
    deps.stdout(`  PRs are ${github.allowReadyPulls ? 'drafts unless a Session asks otherwise' : 'always drafts'}; Sessions write only cloud/<host>/ branches in the repos you grant them.`);
    if (!broker) deps.stdout('  warning: could not ask the coordinator for the broker status; check with runpane cloud coordinator github status.');
    else if (brokerError) deps.stdout(`  warning: the coordinator reports: ${brokerError}`);
  }
  return summary.ok ? 0 : 1;
}

async function brokerStatus(deps: CloudDeps): Promise<JsonObject | null> {
  if (!deps.callCoordinatorApi) return null;
  const result = await deps.callCoordinatorApi('GET', '/cloud/github/status', undefined, 60_000).catch(() => null);
  return result ? objectOf(result.body) : null;
}

async function status(args: GitHubArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireCoordinatorDeployment(deps);
  const broker = await brokerStatus(deps);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: broker !== null && broker.ok === true && broker.error === undefined, configured: deployment.github ?? null, broker }, null, 2));
  } else if (!broker) {
    deps.stdout(`coordinator ${deployment.hostname}: could not reach its API (is it running? runpane cloud coordinator status).`);
  } else {
    const app = objectOf(broker.app);
    deps.stdout(`GitHub broker on ${deployment.hostname}: ${String(broker.mode ?? 'unknown')}${broker.mode === 'app' ? ` (App ${String(app.id ?? '?')}${app.slug ? ` "${String(app.slug)}"` : ''})` : ''}`);
    if (typeof broker.error === 'string') deps.stdout(`  error: ${broker.error}`);
    if (broker.mode !== 'off') {
      deps.stdout(`  repos: ${arrayOf(broker.repos).map(String).join(', ') || '(none listed)'}`);
      deps.stdout(`  ready PRs allowed: ${broker.allowReadyPulls === true ? 'yes' : 'no (always drafts)'}`);
      const tokens = arrayOf(broker.tokens).map(objectOf);
      deps.stdout(`  cached installation tokens: ${tokens.length === 0 ? 'none' : tokens.map((token) => `${String(token.repo)} ${String(token.access)} until ${String(token.expiresAt)}`).join('; ')}`);
    }
  }
  return broker ? 0 : 1;
}

async function audit(args: GitHubArgs, deps: CloudDeps): Promise<number> {
  await requireCoordinatorDeployment(deps);
  if (!deps.callCoordinatorApi) throw new Error('This build cannot call the coordinator API.');
  const result = await deps.callCoordinatorApi('GET', `/cloud/github/audit?limit=${args.limit}`, undefined, 60_000);
  const body = objectOf(result.body);
  if (result.status !== 200) throw new Error(`The coordinator answered ${result.status}: ${String(body.message ?? '')}`);
  const entries = arrayOf(body.entries).map(objectOf);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, entries }, null, 2));
  } else if (entries.length === 0) {
    deps.stdout('No GitHub broker calls yet.');
  } else {
    for (const entry of entries) {
      const target = [entry.repo, entry.target].filter((part) => typeof part === 'string').join(' ');
      deps.stdout(`${String(entry.at)}  ${String(entry.label ?? entry.callerId)}  ${String(entry.endpoint)}  ${target}  ${String(entry.outcome)}${entry.githubUrl ? `  ${String(entry.githubUrl)}` : ''}`);
    }
  }
  return 0;
}

async function unset(args: GitHubArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) throw new Error('runpane cloud coordinator github unset turns the broker off and shreds its credential on the coordinator. Rerun with --yes to confirm.');
  const deployment = await requireCoordinatorDeployment(deps);
  const next: CoordinatorDeployment = { ...deployment };
  delete next.github;
  const { provider } = await loadCoordinatorProvider(deps);
  await reconfigureCoordinator(provider, next, { removeGitHubCredentials: true });
  await saveCoordinatorDeployment(deps, next);
  const text = deployment.github?.mode === 'pat'
    ? 'The PAT still exists on GitHub: delete it under Settings -> Developer settings -> Fine-grained tokens.'
    : deployment.github?.mode === 'app'
      ? 'The App and its private key still exist on GitHub: revoke the key (App settings -> Private keys) or uninstall the App if you are done with it.'
      : 'It was not configured.';
  if (args.json) deps.stdout(JSON.stringify({ ok: true, removed: deployment.github?.mode ?? null }, null, 2));
  else deps.stdout(`runpane cloud: the GitHub broker on ${deployment.hostname} is off and its credential was shredded there. ${text}`);
  return 0;
}
