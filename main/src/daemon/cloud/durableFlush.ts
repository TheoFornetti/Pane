import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CloudDurableFlushResult, CloudWalCheckpoint } from '../../../../shared/types/cloudDaemon';

const SYNC_TIMEOUT_MS = 30_000;

export interface DurableFlushDependencies {
  /** Folds the SQLite WAL into the main database file. */
  checkpointWal(): CloudWalCheckpoint | null;
  /** The Pane directory: sessions.db, its WAL, config and the JSON stores live at its top level. */
  paneDirectory: string;
  /** Flushes the whole filesystem holding `directory` (worktrees, agent transcripts). */
  syncFilesystem?(directory: string): Promise<boolean>;
  /**
   * Refreshes the in-place copy of tailscaled.state that cloud bootstrap keeps (rp-tailscale-state):
   * a resume can lose the state file itself, and a logged-out node can't be reached to repair it.
   */
  backupTailnetState?(): Promise<boolean>;
  now?: () => number;
}

/** Installed by runpane cloud bootstrap on cloud sandboxes; absent anywhere else. */
const TAILNET_STATE_GUARD = '/usr/local/sbin/rp-tailscale-state';

/**
 * Makes everything the daemon has written durable on disk: checkpoint the WAL, fsync every
 * file at the top of the Pane directory and the directory itself, then sync the filesystem.
 * `synchronous = NORMAL` leaves WAL commits unsynced until a checkpoint, so a power-off right
 * after the last commit can drop it; this closes that window before a planned stop.
 */
export async function flushDurableState(dependencies: DurableFlushDependencies): Promise<CloudDurableFlushResult> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const walCheckpoint = dependencies.checkpointWal();
  const fsynced: string[] = [];

  for (const entry of listTopLevelFiles(dependencies.paneDirectory)) {
    if (fsyncPath(entry)) fsynced.push(entry);
  }
  if (fsyncPath(dependencies.paneDirectory)) fsynced.push(dependencies.paneDirectory);

  await (dependencies.backupTailnetState ?? backupTailnetStateWithGuard)();

  const syncFilesystem = dependencies.syncFilesystem ?? syncFilesystemWithCoreutils;
  const syncedFilesystem = await syncFilesystem(dependencies.paneDirectory);

  return { walCheckpoint, fsynced, syncedFilesystem, durationMs: now() - startedAt };
}

function listTopLevelFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function fsyncPath(target: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    // A file removed since the listing, or a platform that cannot fsync a directory.
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Best effort: the guard is root-owned, so it runs through passwordless sudo, as upgrades do. */
function backupTailnetStateWithGuard(): Promise<boolean> {
  if (process.platform !== 'linux' || !fs.existsSync(TAILNET_STATE_GUARD)) return Promise.resolve(false);
  return new Promise(resolve => {
    execFile('sudo', ['-n', TAILNET_STATE_GUARD, 'backup'], { timeout: SYNC_TIMEOUT_MS }, error => resolve(!error));
  });
}

/** `sync -f` syncs the one filesystem (syncfs); older coreutils fall back to a full `sync`. */
function syncFilesystemWithCoreutils(directory: string): Promise<boolean> {
  if (process.platform === 'win32') return Promise.resolve(false);
  return runSync(['-f', directory]).then(ok => ok || runSync([]));
}

function runSync(args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    execFile('sync', args, { timeout: SYNC_TIMEOUT_MS }, error => resolve(!error));
  });
}
