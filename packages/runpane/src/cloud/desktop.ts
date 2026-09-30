import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isNotFound } from './store';
import type { CloudHostProfile } from './store';

/**
 * Puts cloud host profiles into the desktop Pane's saved remote hosts, so the host switcher (#853)
 * lists them. This is the "existing import path" of final-plan S2 note 3, done on disk: the desktop
 * keeps profiles in `<desktop dir>/config.json` under `remoteDaemon.client.profiles`, and its
 * ConfigManager watches that file and reloads outside edits. The desktop never creates or manages
 * machines (#695); it only sees profiles.
 *
 * The desktop dir is `--desktop-dir`, then `$RUNPANE_CLOUD_DESKTOP_DIR`, then `~/.pane`. `$PANE_DIR` is
 * ignored on purpose: inside a Pane terminal it names the daemon hosting that terminal, which may be a
 * remote daemon, not the desktop.
 */

export function defaultDesktopDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNPANE_CLOUD_DESKTOP_DIR) return path.resolve(env.RUNPANE_CLOUD_DESKTOP_DIR);
  return path.join(os.homedir(), '.pane');
}

export interface DesktopImportResult {
  configPath: string;
  added: string[];
  updated: string[];
  removed: string[];
}

type JsonRecord = Record<string, unknown>;

export async function syncDesktopProfiles(options: {
  desktopDir: string;
  upsert?: readonly CloudHostProfile[];
  /** Cloud Session ids whose profiles should be removed (after `destroy`). */
  removeSessionIds?: readonly string[];
}): Promise<DesktopImportResult> {
  const configPath = path.join(options.desktopDir, 'config.json');
  const result: DesktopImportResult = { configPath, added: [], updated: [], removed: [] };
  let config: JsonRecord = {};
  let mode = 0o600;
  try {
    const text = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error(`${configPath} is not a JSON object.`);
    config = parsed;
    mode = (await fs.stat(configPath)).mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const remoteDaemon = isRecord(config.remoteDaemon) ? { ...config.remoteDaemon } : {};
  const client = isRecord(remoteDaemon.client) ? { ...remoteDaemon.client } : {};
  let profiles: JsonRecord[] = Array.isArray(client.profiles) ? client.profiles.filter(isRecord) : [];
  let activeProfileId = typeof client.activeProfileId === 'string' ? client.activeProfileId : null;
  let clientMode = client.mode === 'remote' ? 'remote' : 'local';

  for (const sessionId of options.removeSessionIds ?? []) {
    const before = profiles.length;
    const removedIds = profiles.filter((profile) => cloudSessionId(profile) === sessionId).map((profile) => profile.id);
    profiles = profiles.filter((profile) => cloudSessionId(profile) !== sessionId);
    if (profiles.length !== before) result.removed.push(sessionId);
    if (activeProfileId && removedIds.includes(activeProfileId)) {
      activeProfileId = null;
      clientMode = 'local';
    }
  }

  for (const profile of options.upsert ?? []) {
    const index = profiles.findIndex((existing) =>
      cloudSessionId(existing) === profile.cloud.sessionId || existing.baseUrl === profile.baseUrl);
    if (index === -1) {
      profiles.push({ ...profile });
      result.added.push(profile.cloud.hostname);
    } else {
      // Keep the desktop's profile id so an active connection and any references survive.
      const existingId = typeof profiles[index].id === 'string' ? profiles[index].id : profile.id;
      profiles[index] = { ...profile, id: existingId };
      result.updated.push(profile.cloud.hostname);
    }
  }

  client.profiles = profiles;
  client.activeProfileId = activeProfileId;
  client.mode = activeProfileId ? clientMode : 'local';
  remoteDaemon.client = client;
  const next = { ...config, remoteDaemon };

  await fs.mkdir(options.desktopDir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.runpane-cloud.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, configPath);
  return result;
}

function cloudSessionId(profile: JsonRecord): string | undefined {
  const cloud = profile.cloud;
  return isRecord(cloud) && typeof cloud.sessionId === 'string' ? cloud.sessionId : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
