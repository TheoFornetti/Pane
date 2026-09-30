import { promises as fs } from 'node:fs';
import type { JsonObject } from '../boundaryDecoder';
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

export async function buildCoordinatorDirectory(records: readonly CloudHostRecord[], generatedAt: Date): Promise<JsonObject> {
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
