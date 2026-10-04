import path from 'path';
import type { CommandRunner } from '../utils/commandRunner';
import { withLock } from '../utils/mutex';
import { archiveFs, archivePathKey } from './archiveCleanupFilesystem';

/** Share native Git mutation serialization with durable archive jobs. */
export async function withArchiveRepositoryLock<T>(project: string, runner: CommandRunner, action: () => Promise<T>): Promise<T> {
  if (runner.wslContext) return action();
  let key: string;
  try {
    const { stdout } = await runner.execFile('git', ['rev-parse', '--git-common-dir'], project, { silent: true, timeout: 30000 });
    key = archivePathKey(await archiveFs.realpath(path.resolve(project, stdout.trim())));
  } catch {
    key = archivePathKey(project);
  }
  return withLock(`archive-repository:${key}`, action);
}
