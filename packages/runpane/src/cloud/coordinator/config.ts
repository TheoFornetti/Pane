import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';

export const COORDINATOR_UNIT_NAME = 'runpane-cloud-coordinator.service';
export const DEFAULT_COORDINATOR_PORT = 47300;

export interface CoordinatorConfig {
  listenHost: string;
  listenPort: number;
  stateDir: string;
  directoryFile: string;
  /** HMAC secret used to mint and verify caller tokens (0600). */
  secretFile: string;
  /** `org`: the boat wallet its calls default to (X-Boat-Org); null: the account's active wallet. */
  provider: { kind: 'boat'; apiBase: string; apiKeyFile: string; org: string | null };
  /** Only provider sandboxes whose name starts with this prefix are cloud Sessions. */
  managedNamePrefix: string;
  /** The coordinator's own sandbox; never counted as an orphan or stopped. */
  selfSandboxId: string | null;
  ignoreSandboxIds: string[];
  pinnedVersion: string | null;
  pinnedDebUrl: string | null;
  pinnedDebSha256: string | null;
  idleStop: {
    enabled: boolean;
    intervalSeconds: number;
    requiredConsecutiveSafe: number;
    wakeGraceSeconds: number;
    dryRun: boolean;
  };
  reconcile: {
    enabled: boolean;
    intervalSeconds: number;
    orphanGraceSeconds: number;
    maxOrphanStopsPerRun: number;
    dryRun: boolean;
  };
  guards: {
    maxLiveSandboxes: number;
    maxResumesPerSandboxPerHour: number;
    maxResumesPerHour: number;
  };
  wake: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    daemonDownGraceSeconds: number;
    pollIntervalMs: number;
    upgradeTimeoutMs: number;
  };
  alerts: { webhookUrl: string | null };
  revokedCallers: string[];
}

const optionalNumber = boundary.optional(boundary.number);
const optionalBoolean = boundary.optional(boundary.boolean);
const optionalString = boundary.optional(boundary.string);
const optionalNullableString = boundary.optional(boundary.nullable(boundary.string));

const rawConfigSchema = boundary.object({
  version: boundary.literal(1),
  listenHost: boundary.nonEmptyString,
  listenPort: optionalNumber,
  stateDir: optionalString,
  directoryFile: optionalString,
  secretFile: optionalString,
  provider: boundary.object({
    kind: boundary.literal('boat'),
    apiBase: optionalString,
    apiKeyFile: boundary.nonEmptyString,
    org: optionalNullableString,
  }),
  managedNamePrefix: boundary.nonEmptyString,
  selfSandboxId: optionalNullableString,
  ignoreSandboxIds: boundary.optional(boundary.array(boundary.string)),
  pinnedVersion: optionalNullableString,
  pinnedDebUrl: optionalNullableString,
  pinnedDebSha256: optionalNullableString,
  idleStop: boundary.optional(boundary.object({
    enabled: optionalBoolean,
    intervalSeconds: optionalNumber,
    requiredConsecutiveSafe: optionalNumber,
    wakeGraceSeconds: optionalNumber,
    dryRun: optionalBoolean,
  })),
  reconcile: boundary.optional(boundary.object({
    enabled: optionalBoolean,
    intervalSeconds: optionalNumber,
    orphanGraceSeconds: optionalNumber,
    maxOrphanStopsPerRun: optionalNumber,
    dryRun: optionalBoolean,
  })),
  guards: boundary.optional(boundary.object({
    maxLiveSandboxes: optionalNumber,
    maxResumesPerSandboxPerHour: optionalNumber,
    maxResumesPerHour: optionalNumber,
  })),
  wake: boundary.optional(boundary.object({
    defaultTimeoutMs: optionalNumber,
    maxTimeoutMs: optionalNumber,
    daemonDownGraceSeconds: optionalNumber,
    pollIntervalMs: optionalNumber,
    upgradeTimeoutMs: optionalNumber,
  })),
  alerts: boundary.optional(boundary.object({ webhookUrl: optionalNullableString })),
  revokedCallers: boundary.optional(boundary.array(boundary.string)),
});

export function defaultCoordinatorHome(): string {
  return path.join(os.homedir(), '.config', 'runpane-cloud-coordinator');
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`coordinator config: ${name} must be a positive number`);
  }
  return value;
}

export function parseCoordinatorConfig(value: JsonValue, home = defaultCoordinatorHome()): CoordinatorConfig {
  const raw = decodeBoundary(value, rawConfigSchema);
  const stateDir = raw.stateDir ?? path.join(home, 'state');
  if (raw.listenHost === '0.0.0.0' || raw.listenHost === '::') {
    // Sandboxes have public addresses; the coordinator must only listen on its tailnet address.
    throw new Error('coordinator config: listenHost must be a specific (tailnet) address, not a wildcard');
  }
  return {
    listenHost: raw.listenHost,
    listenPort: positive(raw.listenPort, DEFAULT_COORDINATOR_PORT, 'listenPort'),
    stateDir,
    directoryFile: raw.directoryFile ?? path.join(home, 'directory.json'),
    secretFile: raw.secretFile ?? path.join(home, 'caller-secret'),
    provider: {
      kind: 'boat',
      apiBase: (raw.provider.apiBase ?? 'https://boat.dev/api/v1').replace(/\/+$/, ''),
      apiKeyFile: raw.provider.apiKeyFile,
      org: raw.provider.org ?? null,
    },
    managedNamePrefix: raw.managedNamePrefix,
    selfSandboxId: raw.selfSandboxId ?? null,
    ignoreSandboxIds: raw.ignoreSandboxIds ?? [],
    pinnedVersion: raw.pinnedVersion ?? null,
    pinnedDebUrl: raw.pinnedDebUrl ?? null,
    pinnedDebSha256: raw.pinnedDebSha256 ?? null,
    idleStop: {
      enabled: raw.idleStop?.enabled ?? true,
      intervalSeconds: positive(raw.idleStop?.intervalSeconds, 300, 'idleStop.intervalSeconds'),
      requiredConsecutiveSafe: positive(raw.idleStop?.requiredConsecutiveSafe, 2, 'idleStop.requiredConsecutiveSafe'),
      wakeGraceSeconds: raw.idleStop?.wakeGraceSeconds ?? 600,
      dryRun: raw.idleStop?.dryRun ?? false,
    },
    reconcile: {
      enabled: raw.reconcile?.enabled ?? true,
      intervalSeconds: positive(raw.reconcile?.intervalSeconds, 600, 'reconcile.intervalSeconds'),
      orphanGraceSeconds: raw.reconcile?.orphanGraceSeconds ?? 1800,
      maxOrphanStopsPerRun: raw.reconcile?.maxOrphanStopsPerRun ?? 3,
      dryRun: raw.reconcile?.dryRun ?? false,
    },
    guards: {
      maxLiveSandboxes: positive(raw.guards?.maxLiveSandboxes, 25, 'guards.maxLiveSandboxes'),
      maxResumesPerSandboxPerHour: positive(raw.guards?.maxResumesPerSandboxPerHour, 6, 'guards.maxResumesPerSandboxPerHour'),
      maxResumesPerHour: positive(raw.guards?.maxResumesPerHour, 60, 'guards.maxResumesPerHour'),
    },
    wake: {
      defaultTimeoutMs: positive(raw.wake?.defaultTimeoutMs, 90_000, 'wake.defaultTimeoutMs'),
      maxTimeoutMs: positive(raw.wake?.maxTimeoutMs, 300_000, 'wake.maxTimeoutMs'),
      daemonDownGraceSeconds: positive(raw.wake?.daemonDownGraceSeconds, 60, 'wake.daemonDownGraceSeconds'),
      pollIntervalMs: positive(raw.wake?.pollIntervalMs, 1000, 'wake.pollIntervalMs'),
      upgradeTimeoutMs: positive(raw.wake?.upgradeTimeoutMs, 180_000, 'wake.upgradeTimeoutMs'),
    },
    alerts: { webhookUrl: raw.alerts?.webhookUrl ?? null },
    revokedCallers: raw.revokedCallers ?? [],
  };
}

export function loadCoordinatorConfig(file: string): CoordinatorConfig {
  const home = path.dirname(file);
  return parseCoordinatorConfig(JSON.parse(fs.readFileSync(file, 'utf8')), home);
}

/** Reads a secret file (0600 expected) and strips the trailing newline secret stores often add. */
export function readSecretFile(file: string): string {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${file} must not be readable by group or others (chmod 600)`);
  }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length === 0) throw new Error(`${file} is empty`);
  return value;
}
