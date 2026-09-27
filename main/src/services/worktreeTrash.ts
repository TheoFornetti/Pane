import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';
import { forceRemoveWorktree, stopFsmonitorDaemon } from './gitPerformanceConfig';

/**
 * Once the worktree is removed, whether its files are fully deleted:
 * - `done`: the files are gone.
 * - `pending`: git no longer knows the worktree and its path is free, but its
 *   files are still being deleted from the trash in the background.
 */
export type WorktreeTrashDeletion = 'pending' | 'done';

const TRASH_DIRECTORY = 'pane-trash';
/** Small worktrees usually finish deleting within this window, so they report `removed`. */
const INLINE_DELETE_GRACE_MS = 1_500;
const GIT_TIMEOUT_MS = 30_000;

const pendingDeletes = new Map<string, Promise<void>>();

/**
 * Removes a linked worktree without waiting for its files to be deleted.
 *
 * `git worktree remove` deletes every file before returning, which takes
 * minutes for a large `node_modules`. Instead, the directory is renamed into
 * `<git-common-dir>/pane-trash/`, which is on the same filesystem as the
 * repository and so is instant, then `git worktree prune` drops git's record
 * of it and the files are deleted in the background. The branch is kept.
 *
 * Falls back to `git worktree remove --force` when the rename cannot work:
 * WSL projects, a path that is not a linked worktree of this repository, or a
 * rename that fails (a worktree on another filesystem, or open files on Windows).
 */
export async function removeWorktreeViaTrash(
  worktreePath: string,
  projectPath: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
  options: { label?: string; inlineGraceMs?: number } = {},
): Promise<WorktreeTrashDeletion> {
  const trashRoot = await resolveTrashRoot(worktreePath, projectPath, pathResolver, commandRunner);
  if (!trashRoot) {
    await forceRemoveWorktree(worktreePath, projectPath, commandRunner);
    return 'done';
  }

  await stopFsmonitorDaemon(worktreePath, commandRunner);
  const entryName = `${sanitizeTrashLabel(options.label ?? path.basename(worktreePath))}-${randomBytes(4).toString('hex')}`;
  const trashPath = path.join(trashRoot, entryName);
  try {
    await fs.mkdir(trashRoot, { recursive: true });
    await fs.rename(worktreePath, trashPath);
  } catch (error) {
    console.warn(`[WorktreeTrash] rename_failed worktreePath=${JSON.stringify(worktreePath)} falling back to git worktree remove:`, error);
    await forceRemoveWorktree(worktreePath, projectPath, commandRunner);
    return 'done';
  }

  // Register before anything else awaits so a concurrent sweep skips this entry.
  const deletion = deleteTrashEntry(trashPath);
  try {
    await commandRunner.execFile('git', ['worktree', 'prune'], projectPath, { silent: true, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    // The worktree's directory is already gone, so git prunes the stale record on its next gc.
    console.warn(`[WorktreeTrash] prune_failed projectPath=${JSON.stringify(projectPath)}:`, error);
  }
  void sweepTrashRoot(trashRoot);

  const graceMs = options.inlineGraceMs ?? INLINE_DELETE_GRACE_MS;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    deletion.then(() => true),
    new Promise<boolean>(resolve => {
      graceTimer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  clearTimeout(graceTimer);
  return finished ? 'done' : 'pending';
}

/**
 * Deletes trash left behind by an earlier run, for example when Pane quit
 * while a background delete was still running.
 */
export async function sweepWorktreeTrash(
  projectPath: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
): Promise<void> {
  if (!supportsTrash(pathResolver, commandRunner)) return;
  try {
    const [commonDirectory] = await revParse(projectPath, ['--git-common-dir'], commandRunner);
    if (!commonDirectory) return;
    await sweepTrashRoot(path.join(commonDirectory, TRASH_DIRECTORY));
  } catch (error) {
    console.warn(`[WorktreeTrash] sweep_failed projectPath=${JSON.stringify(projectPath)}:`, error);
  }
}

/** Resolves once every background delete started so far has finished. For tests and shutdown. */
export async function waitForPendingWorktreeTrash(): Promise<void> {
  await Promise.all([...pendingDeletes.values()]);
}

async function sweepTrashRoot(trashRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(trashRoot);
  } catch {
    return;
  }
  await Promise.all(entries.map(entry => deleteTrashEntry(path.join(trashRoot, entry))));
}

function deleteTrashEntry(trashPath: string): Promise<void> {
  const pending = pendingDeletes.get(trashPath);
  if (pending) return pending;
  const deletion = fs.rm(trashPath, { recursive: true, force: true, maxRetries: 3 })
    .catch(error => {
      console.warn(`[WorktreeTrash] delete_failed trashPath=${JSON.stringify(trashPath)}:`, error);
    })
    .finally(() => {
      pendingDeletes.delete(trashPath);
    });
  pendingDeletes.set(trashPath, deletion);
  return deletion;
}

/**
 * How `worktreePath` relates to the project's repository:
 * - `linked`: a linked worktree (`git worktree add`), which is safe to remove.
 * - `main`: the repository's main checkout.
 * - `foreign`: a checkout of a different repository.
 * - `unknown`: git could not answer, for example because the path is gone.
 */
export async function classifyWorktree(
  worktreePath: string,
  projectPath: string,
  commandRunner: CommandRunner,
): Promise<{ kind: 'linked'; commonDirectory: string; gitDirectory: string } | { kind: 'main' | 'foreign' | 'unknown' }> {
  try {
    const [projectCommon] = await revParse(projectPath, ['--git-common-dir'], commandRunner);
    const [worktreeGitDir, worktreeCommon] = await revParse(worktreePath, ['--git-dir', '--git-common-dir'], commandRunner);
    if (!projectCommon || !worktreeGitDir || !worktreeCommon) return { kind: 'unknown' };
    const [common, candidateCommon, candidateGitDir] = await Promise.all([
      fs.realpath(projectCommon),
      fs.realpath(worktreeCommon),
      fs.realpath(worktreeGitDir),
    ]);
    if (candidateCommon !== common) return { kind: 'foreign' };
    if (candidateGitDir === common) return { kind: 'main' };
    return { kind: 'linked', commonDirectory: common, gitDirectory: candidateGitDir };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The trash directory for a linked worktree of the project's repository, or
 * null when the fast path does not apply. The main checkout and a separate
 * clone are never moved, and neither is a locked worktree: `git worktree
 * prune` keeps its record, and `git worktree remove --force` refuses it too.
 */
async function resolveTrashRoot(
  worktreePath: string,
  projectPath: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
): Promise<string | null> {
  if (!supportsTrash(pathResolver, commandRunner)) return null;
  const worktree = await classifyWorktree(worktreePath, projectPath, commandRunner);
  if (worktree.kind !== 'linked') return null;
  const locked = await fs.access(path.join(worktree.gitDirectory, 'locked')).then(() => true, () => false);
  return locked ? null : path.join(worktree.commonDirectory, TRASH_DIRECTORY);
}

function supportsTrash(pathResolver: PathResolver, commandRunner: CommandRunner): boolean {
  // WSL paths are Linux paths that Node reaches through \\wsl$ shares; keep git's own removal there.
  return pathResolver.environment !== 'wsl' && !commandRunner.wslContext;
}

async function revParse(cwd: string, flags: readonly string[], commandRunner: CommandRunner): Promise<string[]> {
  const { stdout } = await commandRunner.execFile('git', ['rev-parse', ...flags], cwd, { silent: true, timeout: GIT_TIMEOUT_MS });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(value => path.resolve(cwd, value));
}

function sanitizeTrashLabel(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+/u, '').slice(0, 80);
  return sanitized || 'worktree';
}
