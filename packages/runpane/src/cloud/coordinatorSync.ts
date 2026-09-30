import { promises as fs } from 'node:fs';
import type { JsonObject } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { decodePairingCode } from './pairing';
import { isNotFound, type CloudHostRecord } from './store';

/**
 * The directory the coordinator reads (iface-coordinator.md; parsed by coordinator/directory.ts).
 * `runpane cloud` on the user's machine is its single writer: it pushes the whole directory after
 * every change (new, destroy, sync), so the coordinator never guesses which Sessions exist.
 */

export const NO_COORDINATOR = 'no coordinator configured';

export type CoordinatorPushResult =
  | { pushed: true; sessions: number }
  | { pushed: false; reason: string };

async function buildCoordinatorDirectory(records: readonly CloudHostRecord[], generatedAt: Date): Promise<JsonObject> {
  const sessions: JsonObject[] = [];
  for (const record of records) {
    // A host whose setup has not finished has no address yet; `new` pushes again once it does.
    if (!record.profile.baseUrl) continue;
    sessions.push({
      sessionId: record.profile.cloud.sessionId,
      label: record.profile.label,
      provider: record.profile.cloud.provider,
      sandboxId: record.profile.cloud.sandboxId,
      baseUrl: record.profile.baseUrl,
      nodeId: record.profile.cloud.nodeId || null,
      pinnedVersion: record.meta.pinnedVersion ?? null,
      coordinatorToken: await readCoordinatorToken(record.meta.coordinatorPairingPath),
      org: record.meta.boatOrg?.id ?? null,
    });
  }
  return { version: 1, generatedAt: generatedAt.toISOString(), sessions };
}

/** The coordinator's own paired-client token, from the pairing code bootstrap minted for it. */
async function readCoordinatorToken(pairingPath: string | undefined): Promise<string | null> {
  if (!pairingPath) return null;
  try {
    return decodePairingCode(await fs.readFile(pairingPath, 'utf8')).token;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Pushes the whole directory after a change. Never throws: the change itself already happened. */
export async function pushDirectory(deps: Pick<CloudDeps, 'store' | 'now' | 'pushCoordinatorDirectory'>): Promise<CoordinatorPushResult> {
  try {
    const directory = await buildCoordinatorDirectory(await deps.store.listHosts(), new Date(deps.now()));
    return await deps.pushCoordinatorDirectory(directory);
  } catch (error) {
    return { pushed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
