import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../boundaryDecoder';
import { BrokerError } from './brokerClient';
import { lastValue, parseAgentFlags, parseItemNumber, UnsupportedFlagError, type FlagSpec, type ParsedFlags } from './flags';
import { currentBranch, lastCommitMessage, repoRoot } from './localGit';
import { pushBranch, readBody, resolveRepo, sessionBroker, type AgentDeps } from './session';

/**
 * A `gh` look-alike for cloud Sessions (installed as ~/.local/bin/gh when the broker is enabled): the
 * pr and issue verbs agents and WORKER.md already use, mapped onto the coordinator's broker. Anything
 * else exits 2, because the broker is an allowlist and this Session holds no GitHub credential.
 */

const REFUSED = 'not available in a runpane cloud Session (broker allowlist)';
const SUPPORTED = [
  'gh pr create|view|list|comment|close|edit',
  'gh issue create|view|list|comment|close',
  'gh auth status',
];
const GH_SHIM_USAGE = `gh (runpane cloud broker shim): GitHub through the runpane cloud coordinator.
Supported: ${SUPPORTED.join('; ')}.
Pull requests open as drafts under cloud/<host>/<branch>; merging, reviews, releases, gh api and the rest are ${REFUSED}.
Also: runpane cloud agent github --help`;

class Refused extends Error {
  override name = 'Refused';
}

/** Exit codes follow gh: 0 ok, 1 failure, 2 usage (here also: refused by the allowlist). */
export async function runGhShim(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const args = [...argv];
  const [group, action] = args;
  try {
    if (group === '--version' || group === 'version') {
      deps.stdout('gh version 0.0.0-runpane-cloud-shim (runpane cloud broker; not the GitHub CLI)');
      return 0;
    }
    if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
      deps.stdout(GH_SHIM_USAGE);
      return group === undefined ? 2 : 0;
    }
    if (group === 'auth' && action === 'status') return await authStatus(args.slice(2), deps);
    if (group === 'pr' && action && ['create', 'view', 'list', 'comment', 'close', 'edit'].includes(action)) return await pr(action, args.slice(2), deps);
    if (group === 'issue' && action && ['create', 'view', 'list', 'comment', 'close'].includes(action)) return await issue(action, args.slice(2), deps);
    throw new Refused(`gh ${[group, action].filter(Boolean).join(' ')}`);
  } catch (error) {
    if (error instanceof Refused || error instanceof UnsupportedFlagError) {
      const what = error instanceof UnsupportedFlagError ? `gh ${[group, action].filter(Boolean).join(' ')} ${error.flag}` : error.message;
      deps.stderr(`${what}: ${REFUSED}.\nSupported: ${SUPPORTED.join('; ')}. See runpane cloud agent github --help.`);
      return 2;
    }
    deps.stderr(error instanceof BrokerError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// ---------------------------------------------------------------- shared

const REPO_FLAG = ['--repo', '-R'] as const;
const BODY_FLAGS = [['--body', '-b'], ['--body-file', '-F']] as const;
const JSON_FLAG = ['--json'] as const;

function flags(argv: readonly string[], values: (readonly string[])[], booleans: (readonly string[])[] = []): ParsedFlags {
  const spec: FlagSpec = { values: [REPO_FLAG, ...values], booleans };
  return parseAgentFlags(argv, spec);
}

async function repoOf(deps: AgentDeps, parsed: ParsedFlags): Promise<string> {
  return resolveRepo(deps, lastValue(parsed, '--repo'), deps.cwd);
}

/** `cloud/<host>/<branch>` or `owner:branch` as given to --head: the Session-local branch name. */
function localBranchName(head: string): string {
  const withoutOwner = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
  const parts = withoutOwner.split('/');
  return parts[0] === 'cloud' && parts.length >= 3 ? parts.slice(2).join('/') : withoutOwner;
}

const optionalText = boundary.optional(boundary.nullable(boundary.string));
const branchRefSchema = boundary.optional(boundary.nullable(boundary.object({ ref: optionalText, sha: optionalText })));

/** A GitHub REST pull request or issue, as the broker's read passthrough returns it (only what gh shows). */
const restItemSchema = boundary.object({
  number: boundary.number,
  title: optionalText,
  body: optionalText,
  state: optionalText,
  html_url: optionalText,
  user: boundary.optional(boundary.nullable(boundary.object({ login: optionalText }))),
  labels: boundary.optional(boundary.nullable(boundary.array(boundary.object({ name: optionalText })))),
  created_at: optionalText,
  updated_at: optionalText,
  closed_at: optionalText,
  merged_at: optionalText,
  node_id: optionalText,
  draft: boundary.optional(boundary.nullable(boundary.boolean)),
  head: branchRefSchema,
  base: branchRefSchema,
  pull_request: boundary.optional(boundary.nullable(boundary.json)),
});

const commentsSchema = boundary.array(boundary.object({
  body: optionalText,
  user: boundary.optional(boundary.nullable(boundary.object({ login: optionalText }))),
}));

function decodeItem(value: JsonValue) {
  return decodeBoundary(value, restItemSchema);
}

type RestItem = ReturnType<typeof decodeItem>;

function ghState(item: RestItem): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (item.state?.toLowerCase() !== 'closed') return 'OPEN';
  return item.merged_at ? 'MERGED' : 'CLOSED';
}

function labelNames(item: RestItem): string[] {
  return (item.labels ?? []).map((label) => label.name ?? '');
}

/** A REST pull request or issue as gh's --json fields. */
function ghFields(item: RestItem, kind: 'pr' | 'issue'): JsonObject {
  const fields: JsonObject = {
    number: item.number,
    title: item.title ?? '',
    body: item.body ?? '',
    state: ghState(item),
    url: item.html_url ?? '',
    author: { login: item.user?.login ?? '' },
    labels: labelNames(item).map((name) => ({ name })),
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
    closedAt: item.closed_at ?? null,
    id: item.node_id ?? '',
  };
  if (kind === 'pr') {
    fields.isDraft = item.draft === true;
    fields.headRefName = item.head?.ref ?? '';
    fields.headRefOid = item.head?.sha ?? '';
    fields.baseRefName = item.base?.ref ?? '';
    fields.mergedAt = item.merged_at ?? null;
  }
  return fields;
}

/** gh's state column: a draft pull request shows as DRAFT. */
function shownState(item: RestItem): string {
  const state = ghState(item);
  return item.draft === true && state === 'OPEN' ? 'DRAFT' : state;
}

function pickFields(fields: JsonObject, wanted: string): JsonObject {
  const names = wanted.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(name in fields));
  if (unknown.length > 0) throw new Error(`Unknown JSON field: ${unknown.join(', ')}\nAvailable fields:\n  ${Object.keys(fields).sort().join('\n  ')}`);
  return Object.fromEntries(names.map((name) => [name, fields[name]]));
}

function refuseOutputFlags(parsed: ParsedFlags): void {
  if (parsed.values.has('--jq')) throw new UnsupportedFlagError('--jq');
  if (parsed.values.has('--template')) throw new UnsupportedFlagError('--template');
}

/** The open pull request whose head is this Session's copy of `branch`. */
async function pullForBranch(deps: AgentDeps, repo: string, branch: string): Promise<RestItem> {
  const status = await sessionBroker(deps).status().catch(() => null);
  const prefix = status?.caller?.branchPrefix ?? null;
  const match = (await listItems(deps, repo, 'pulls?state=open&per_page=100')).find((pull) => {
    const ref = pull.head?.ref ?? '';
    return prefix ? ref === `${prefix}${branch}` : ref.startsWith('cloud/') && ref.endsWith(`/${branch}`);
  });
  if (!match) throw new Error(`no open pull requests found for branch "${branch}"`);
  return match;
}

async function prNumber(deps: AgentDeps, repo: string, selector: string | undefined): Promise<number> {
  if (selector !== undefined && /^(?:#)?\d+$|\/pull\/\d+\/?$/u.test(selector)) return parseItemNumber(selector, 'pull request');
  const branch = selector !== undefined ? localBranchName(selector) : await currentBranch(deps.git, await repoRoot(deps.git, deps.cwd));
  return (await pullForBranch(deps, repo, branch)).number;
}

// ---------------------------------------------------------------- gh auth status

async function authStatus(argv: readonly string[], deps: AgentDeps): Promise<number> {
  flags(argv, [['--hostname', '-h']], [['--show-token', '-t'], ['--active', '-a']]);
  if (argv.includes('--show-token') || argv.includes('-t')) throw new UnsupportedFlagError('--show-token');
  const broker = sessionBroker(deps);
  const status = await broker.status();
  if (status.mode === 'off') {
    deps.stderr(`github.com\n  X Not logged in: the runpane cloud coordinator at ${broker.baseUrl} has no GitHub credential (broker off).`);
    return 1;
  }
  const repos = status.caller?.repos ?? status.repos;
  deps.stdout([
    'github.com',
    `  ✓ Logged in to github.com through the runpane cloud broker at ${broker.baseUrl} (${status.mode === 'app' ? `GitHub App${status.app ? ` ${status.app}` : ''}` : 'fine-grained token'})`,
    `  - Repositories: ${repos.join(', ') || 'none'}`,
    `  - Branches: ${status.caller?.branchPrefix ?? 'cloud/<host>/'}<branch> only; pull requests are drafts`,
    '  - Token: none in this Session (the coordinator holds the credential)',
  ].join('\n'));
  return 0;
}

// ---------------------------------------------------------------- gh pr

async function pr(action: string, argv: readonly string[], deps: AgentDeps): Promise<number> {
  const broker = () => sessionBroker(deps);
  switch (action) {
    case 'create': {
      const parsed = flags(argv, [['--title', '-t'], ...BODY_FLAGS, ['--base', '-B'], ['--head', '-H']],
        [['--draft', '-d'], ['--fill', '-f'], ['--fill-first'], ['--fill-verbose']]);
      const repo = await repoOf(deps, parsed);
      const root = await repoRoot(deps.git, deps.cwd).catch(() => null);
      const headFlag = lastValue(parsed, '--head');
      const branch = headFlag ? localBranchName(headFlag) : await currentBranch(deps.git, root ?? deps.cwd);
      const fill = parsed.booleans.has('--fill') || parsed.booleans.has('--fill-first') || parsed.booleans.has('--fill-verbose');
      const commit = fill && root ? await lastCommitMessage(deps.git, root) : null;
      const title = lastValue(parsed, '--title') ?? commit?.subject;
      const body = await readBody(deps, lastValue(parsed, '--body'), lastValue(parsed, '--body-file')) ?? commit?.body ?? (fill ? '' : undefined);
      if (!title?.trim() || body === undefined) {
        throw new Error('must provide `--title` and `--body` (or `--fill`) when not running interactively');
      }
      // gh pushes the head branch before opening the pull request; so does the shim, through the broker.
      const local = root ? (await deps.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)).code === 0 : false;
      if (local && root) {
        const pushed = await pushBranch(deps, { dir: root, branch, repo, force: false });
        deps.stderr(`Pushed ${branch} to ${pushed.ref} (${pushed.outcome}) through the runpane cloud broker.`);
      }
      const item = await broker().createPull({ repo, branch, base: lastValue(parsed, '--base'), title, body });
      deps.stderr(`Opened a DRAFT pull request (runpane cloud Sessions only open drafts).`);
      deps.stdout(item.url);
      return 0;
    }
    case 'view': {
      const parsed = flags(argv, [JSON_FLAG, ['--jq', '-q'], ['--template', '-t']], [['--comments', '-c'], ['--web', '-w']]);
      if (parsed.booleans.has('--web')) throw new UnsupportedFlagError('--web');
      refuseOutputFlags(parsed);
      const repo = await repoOf(deps, parsed);
      const number = await prNumber(deps, repo, parsed.positionals[0]);
      const item = decodeItem(await broker().read(repo, `pulls/${number}`));
      const wanted = lastValue(parsed, '--json');
      if (wanted !== undefined) {
        deps.stdout(JSON.stringify(pickFields(ghFields(item, 'pr'), wanted), null, 2));
        return 0;
      }
      deps.stdout([
        `title:\t${item.title ?? ''}`,
        `state:\t${shownState(item)}`,
        `author:\t${item.user?.login ?? ''}`,
        `number:\t${number}`,
        `url:\t${item.html_url ?? ''}`,
        `base:\t${item.base?.ref ?? ''}`,
        `head:\t${item.head?.ref ?? ''}`,
        '--',
        item.body ?? '',
      ].join('\n'));
      if (parsed.booleans.has('--comments')) await printComments(deps, repo, number);
      return 0;
    }
    case 'list': {
      const parsed = flags(argv, [['--state', '-s'], ['--limit', '-L'], ['--head', '-H'], ['--base', '-B'], JSON_FLAG, ['--jq', '-q'], ['--template', '-t']], [['--web', '-w']]);
      if (parsed.booleans.has('--web')) throw new UnsupportedFlagError('--web');
      refuseOutputFlags(parsed);
      const repo = await repoOf(deps, parsed);
      const state = (lastValue(parsed, '--state') ?? 'open').toLowerCase();
      if (!['open', 'closed', 'merged', 'all'].includes(state)) throw new Error(`invalid argument "${state}" for "--state" flag: valid values are {open|closed|merged|all}`);
      const limit = Math.max(1, Math.min(100, Number(lastValue(parsed, '--limit') ?? '30') || 30));
      const query = new URLSearchParams({ state: state === 'merged' ? 'closed' : state, per_page: String(limit) });
      const base = lastValue(parsed, '--base');
      if (base) query.set('base', base);
      const head = lastValue(parsed, '--head');
      const pulls = (await listItems(deps, repo, `pulls?${query.toString()}`))
        .filter((pull) => state !== 'merged' || ghState(pull) === 'MERGED')
        .filter((pull) => !head || pull.head?.ref === head || (pull.head?.ref ?? '').endsWith(`/${localBranchName(head)}`));
      return printList(deps, parsed, pulls, 'pr', (pull) => [String(pull.number), pull.title ?? '', pull.head?.ref ?? '', shownState(pull), pull.created_at ?? '']);
    }
    case 'comment': {
      const parsed = flags(argv, [...BODY_FLAGS], [['--edit-last'], ['--web', '-w'], ['--editor', '-e']]);
      for (const refused of ['--edit-last', '--web', '--editor']) if (parsed.booleans.has(refused)) throw new UnsupportedFlagError(refused);
      const repo = await repoOf(deps, parsed);
      const number = await prNumber(deps, repo, parsed.positionals[0]);
      const body = await readBody(deps, lastValue(parsed, '--body'), lastValue(parsed, '--body-file'));
      if (!body?.trim()) throw new Error('`--body` or `--body-file` required when not running interactively');
      const result = await broker().comment({ repo, number, body });
      deps.stdout(result.url ?? `https://github.com/${repo}/pull/${number}`);
      return 0;
    }
    case 'close': {
      const parsed = flags(argv, [['--comment', '-c']], [['--delete-branch', '-d']]);
      if (parsed.booleans.has('--delete-branch')) throw new UnsupportedFlagError('--delete-branch');
      const repo = await repoOf(deps, parsed);
      const number = await prNumber(deps, repo, parsed.positionals[0]);
      const comment = lastValue(parsed, '--comment');
      if (comment) await broker().comment({ repo, number, body: comment });
      await broker().editPull(number, { repo, state: 'closed' });
      deps.stderr(`✓ Closed pull request ${repo}#${number}`);
      return 0;
    }
    case 'edit': {
      const parsed = flags(argv, [['--title', '-t'], ...BODY_FLAGS]);
      const repo = await repoOf(deps, parsed);
      const number = await prNumber(deps, repo, parsed.positionals[0]);
      const title = lastValue(parsed, '--title');
      const body = await readBody(deps, lastValue(parsed, '--body'), lastValue(parsed, '--body-file'));
      if (title === undefined && body === undefined) throw new Error('no changes: use --title, --body or --body-file');
      const item = await broker().editPull(number, { repo, title, body });
      deps.stdout(item.url || `https://github.com/${repo}/pull/${number}`);
      return 0;
    }
    default:
      throw new Refused(`gh pr ${action}`);
  }
}

// ---------------------------------------------------------------- gh issue

async function issue(action: string, argv: readonly string[], deps: AgentDeps): Promise<number> {
  const broker = () => sessionBroker(deps);
  switch (action) {
    case 'create': {
      const parsed = flags(argv, [['--title', '-t'], ...BODY_FLAGS, ['--label', '-l']]);
      const title = lastValue(parsed, '--title');
      const body = await readBody(deps, lastValue(parsed, '--body'), lastValue(parsed, '--body-file'));
      if (!title?.trim() || body === undefined) throw new Error('must provide `--title` and `--body` when not running interactively');
      const labels = (parsed.values.get('--label') ?? []).flatMap((value) => value.split(',')).map((label) => label.trim()).filter(Boolean);
      const item = await broker().createIssue({ repo: await repoOf(deps, parsed), title, body, labels });
      deps.stdout(item.url);
      return 0;
    }
    case 'view': {
      const parsed = flags(argv, [JSON_FLAG, ['--jq', '-q'], ['--template', '-t']], [['--comments', '-c'], ['--web', '-w']]);
      if (parsed.booleans.has('--web')) throw new UnsupportedFlagError('--web');
      refuseOutputFlags(parsed);
      const repo = await repoOf(deps, parsed);
      const number = parseItemNumber(parsed.positionals[0], 'gh issue view');
      const item = decodeItem(await broker().read(repo, `issues/${number}`));
      const wanted = lastValue(parsed, '--json');
      if (wanted !== undefined) {
        deps.stdout(JSON.stringify(pickFields(ghFields(item, 'issue'), wanted), null, 2));
        return 0;
      }
      deps.stdout([
        `title:\t${item.title ?? ''}`,
        `state:\t${ghState(item)}`,
        `author:\t${item.user?.login ?? ''}`,
        `labels:\t${labelNames(item).join(', ')}`,
        `number:\t${number}`,
        `url:\t${item.html_url ?? ''}`,
        '--',
        item.body ?? '',
      ].join('\n'));
      if (parsed.booleans.has('--comments')) await printComments(deps, repo, number);
      return 0;
    }
    case 'list': {
      const parsed = flags(argv, [['--state', '-s'], ['--limit', '-L'], ['--label', '-l'], JSON_FLAG, ['--jq', '-q'], ['--template', '-t']], [['--web', '-w']]);
      if (parsed.booleans.has('--web')) throw new UnsupportedFlagError('--web');
      refuseOutputFlags(parsed);
      const state = (lastValue(parsed, '--state') ?? 'open').toLowerCase();
      if (!['open', 'closed', 'all'].includes(state)) throw new Error(`invalid argument "${state}" for "--state" flag: valid values are {open|closed|all}`);
      const limit = Math.max(1, Math.min(100, Number(lastValue(parsed, '--limit') ?? '30') || 30));
      const query = new URLSearchParams({ state, per_page: String(limit) });
      const labels = (parsed.values.get('--label') ?? []).join(',');
      if (labels) query.set('labels', labels);
      // GitHub's issues list includes pull requests; gh issue list does not.
      const issues = (await listItems(deps, await repoOf(deps, parsed), `issues?${query.toString()}`))
        .filter((item) => item.pull_request === undefined || item.pull_request === null);
      return printList(deps, parsed, issues, 'issue', (item) => [String(item.number), ghState(item), item.title ?? '', labelNames(item).join(', '), item.updated_at ?? '']);
    }
    case 'comment': {
      const parsed = flags(argv, [...BODY_FLAGS], [['--edit-last'], ['--web', '-w'], ['--editor', '-e']]);
      for (const refused of ['--edit-last', '--web', '--editor']) if (parsed.booleans.has(refused)) throw new UnsupportedFlagError(refused);
      const repo = await repoOf(deps, parsed);
      const number = parseItemNumber(parsed.positionals[0], 'gh issue comment');
      const body = await readBody(deps, lastValue(parsed, '--body'), lastValue(parsed, '--body-file'));
      if (!body?.trim()) throw new Error('`--body` or `--body-file` required when not running interactively');
      const result = await broker().comment({ repo, number, body });
      deps.stdout(result.url ?? `https://github.com/${repo}/issues/${number}`);
      return 0;
    }
    case 'close': {
      const parsed = flags(argv, [['--comment', '-c'], ['--reason', '-r']]);
      const repo = await repoOf(deps, parsed);
      const number = parseItemNumber(parsed.positionals[0], 'gh issue close');
      const comment = lastValue(parsed, '--comment');
      if (comment) await broker().comment({ repo, number, body: comment });
      if (parsed.values.has('--reason')) deps.stderr('note: --reason is ignored; the broker closes issues without a reason.');
      await broker().editIssue(number, { repo, state: 'closed' });
      deps.stderr(`✓ Closed issue ${repo}#${number}`);
      return 0;
    }
    default:
      throw new Refused(`gh issue ${action}`);
  }
}

async function listItems(deps: AgentDeps, repo: string, path: string): Promise<RestItem[]> {
  return decodeBoundary(await sessionBroker(deps).read(repo, path), boundary.array(restItemSchema));
}

function printList(deps: AgentDeps, parsed: ParsedFlags, items: RestItem[], kind: 'pr' | 'issue', row: (item: RestItem) => string[]): number {
  const wanted = lastValue(parsed, '--json');
  if (wanted !== undefined) {
    deps.stdout(JSON.stringify(items.map((item) => pickFields(ghFields(item, kind), wanted)), null, 2));
  } else if (items.length > 0) {
    deps.stdout(items.map((item) => row(item).join('\t')).join('\n'));
  }
  return 0;
}

async function printComments(deps: AgentDeps, repo: string, number: number): Promise<void> {
  const comments = decodeBoundary(await sessionBroker(deps).read(repo, `issues/${number}/comments`), commentsSchema);
  for (const comment of comments) {
    deps.stdout(`--\nauthor:\t${comment.user?.login ?? ''}\n${comment.body ?? ''}`);
  }
}
