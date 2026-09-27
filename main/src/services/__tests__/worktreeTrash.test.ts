import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../../utils/commandRunner';
import { PathResolver } from '../../utils/pathResolver';
import { classifyWorktree, removeWorktreeViaTrash, sweepWorktreeTrash, waitForPendingWorktreeTrash } from '../worktreeTrash';

const directories: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pane-worktree-trash-')));
  directories.push(directory);
  return directory;
}

function repositoryWithWorktree() {
  const repo = join(temporaryDirectory(), 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
  const worktree = join(temporaryDirectory(), 'worktree');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  mkdirSync(join(worktree, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(worktree, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  return { repo, worktree, runner: new CommandRunner({ path: repo }), resolver: new PathResolver({ path: repo }) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await waitForPendingWorktreeTrash();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('removeWorktreeViaTrash', () => {
  it('moves the worktree into the trash, prunes it, and keeps the branch', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-1' });

    expect(outcome).toBe('removed');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
    expect(git(repo, 'branch', '--list', 'feature')).toContain('feature');
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toEqual([]);
  });

  it('reports queued while the files are still being deleted, then deletes them', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    const realRm = fsPromises.rm.bind(fsPromises);
    let release: () => void = () => undefined;
    const released = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      await released;
      return realRm(target, options);
    });

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-2', inlineGraceMs: 10 });

    expect(outcome).toBe('queued');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
    const [entry] = readdirSync(join(repo, '.git', 'pane-trash'));
    expect(entry).toMatch(/^pane-2-[0-9a-f]{8}$/);

    release();
    await waitForPendingWorktreeTrash();
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toEqual([]);
  });

  it('falls back to git worktree remove when the rename fails, for example across filesystems', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner);

    expect(outcome).toBe('removed');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
  });

  it('leaves a locked worktree to git, which refuses to remove it', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    git(repo, 'worktree', 'lock', worktree);

    await expect(removeWorktreeViaTrash(worktree, repo, resolver, runner)).rejects.toThrow(/locked/);

    expect(existsSync(worktree)).toBe(true);
  });

  it('never moves the main checkout', async () => {
    const { repo, runner, resolver } = repositoryWithWorktree();

    await expect(removeWorktreeViaTrash(repo, repo, resolver, runner)).rejects.toThrow();

    expect(existsSync(join(repo, '.git'))).toBe(true);
  });
});

describe('classifyWorktree', () => {
  it('tells linked worktrees from the main checkout and other repositories', async () => {
    const { repo, worktree, runner } = repositoryWithWorktree();
    const other = repositoryWithWorktree();

    await expect(classifyWorktree(worktree, repo, runner)).resolves.toMatchObject({ kind: 'linked' });
    await expect(classifyWorktree(repo, repo, runner)).resolves.toEqual({ kind: 'main' });
    await expect(classifyWorktree(other.worktree, repo, runner)).resolves.toEqual({ kind: 'foreign' });
    await expect(classifyWorktree(join(repo, 'missing'), repo, runner)).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('sweepWorktreeTrash', () => {
  it('deletes trash left behind by an earlier run', async () => {
    const { repo, runner, resolver } = repositoryWithWorktree();
    const leftover = join(repo, '.git', 'pane-trash', 'pane-old-00000000');
    mkdirSync(join(leftover, 'node_modules'), { recursive: true });
    writeFileSync(join(leftover, 'node_modules', 'file.js'), '');

    await sweepWorktreeTrash(repo, resolver, runner);

    expect(existsSync(leftover)).toBe(false);
  });
});
