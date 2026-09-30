import fs from 'fs';
import { boundary, BoundaryDecodeError, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../../shared/validation/boundaryDecoder';
import { SESSION_PORTS_CHANGED_EVENT, type SessionPortsListResult } from '../../../../../shared/types/sessionPorts';
import { PaneCommandError } from '../../../core/commandError';
import type { PaneCommandRegistry, PaneCommandValue } from '../../commandRegistry';
import { readProcessTable } from '../processTree';
import { mapSocketOwners, readLocalListeners } from './listeners';
import { defaultPortsStatePath } from './portsStore';
import { SessionPortsService, type PanelProcess, type ProbeResult } from './sessionPorts';
import { createTailscaleServeBackend, type ServeBackend } from './tailscaleServe';

/** Written by the Session bootstrap (serve guard) on every Runpane Cloud Session: `{"transport","port"}`. */
const CLOUD_SERVE_RECORD = '/etc/rp-cloud/serve.json';
const DEFAULT_DAEMON_PORT = 42137;

export interface SessionPortsWiring {
  commandRegistry: PaneCommandRegistry;
  panelIds(): string[];
  panelPid(panelId: string): number | undefined;
  paneIdOf(panelId: string): string | undefined;
  projectPaths(): string[];
  /** The daemon's own listen port, from its remote config. */
  daemonPort(): number | undefined;
  emit(channel: string, result: SessionPortsListResult): void;
  log(message: string): void;
  /** Tests: the Session marker file and the Serve backend. */
  serveRecordPath?: string;
  serve?: ServeBackend;
  statePath?: string;
}

const serveRecordSchema = boundary.object({ port: boundary.optional(boundary.number) });

const listRequestSchema = boundary.object({ verify: boundary.optional(boundary.boolean) });
const openRequestSchema = boundary.object({
  port: boundary.number,
  name: boundary.optional(boundary.string),
  httpsPort: boundary.optional(boundary.number),
  path: boundary.optional(boundary.string),
  yes: boundary.optional(boundary.boolean),
  scheme: boundary.optional(boundary.enumeration('auto', 'https', 'http')),
});
const closeRequestSchema = boundary.object({ target: boundary.union(boundary.number, boundary.string) });
const configureRequestSchema = boundary.object({ autoOpen: boundary.boolean });

function decodeRequest<T>(value: PaneCommandValue, schema: BoundarySchema<T>): T {
  try {
    return decodeBoundary(value ?? {}, schema);
  } catch (error) {
    if (error instanceof BoundaryDecodeError) throw new PaneCommandError(`Invalid ports request: ${error.message}`, 'ERR_PORTS_INVALID');
    throw error;
  }
}

async function probeUrl(url: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return { ok: true, status: response.status };
  } catch (error) {
    const cause = error instanceof Error ? Reflect.get(error, 'cause') : undefined;
    const code = cause instanceof Error ? Reflect.get(cause, 'code') ?? cause.message : undefined;
    const name = error instanceof Error ? error.name : '';
    return { ok: false, error: name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : String(code ?? (error instanceof Error ? error.message : error)) };
  }
}

/** Whether this daemon runs in a Runpane Cloud Session; ports never act on a laptop's tailnet name. */
function readCloudServeRecord(file: string): { port?: number } | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), serveRecordSchema) ?? {};
  } catch {
    return undefined;
  }
}

/**
 * Registers `runpane:ports:list|open|close|configure` and, in a Runpane Cloud Session, starts the
 * boot/wake reconcile and listener detection. Elsewhere the channels answer `available: false`.
 */
export function registerSessionPortsHandlers(wiring: SessionPortsWiring): SessionPortsService | undefined {
  const serveRecordPath = wiring.serveRecordPath ?? CLOUD_SERVE_RECORD;
  const record = readCloudServeRecord(serveRecordPath);
  const service = new SessionPortsService({
    serve: wiring.serve ?? createTailscaleServeBackend(),
    statePath: wiring.statePath ?? defaultPortsStatePath(),
    reservedPorts: () => [...new Set([wiring.daemonPort() ?? DEFAULT_DAEMON_PORT, record?.port ?? DEFAULT_DAEMON_PORT])],
    projectPaths: () => wiring.projectPaths(),
    panelProcesses: () => wiring.panelIds().flatMap((panelId): PanelProcess[] => {
      const pid = wiring.panelPid(panelId);
      return pid === undefined ? [] : [{ pid, panelId, paneId: wiring.paneIdOf(panelId) }];
    }),
    readListeners: () => readLocalListeners(),
    readProcesses: () => readProcessTable(),
    mapSocketOwners: (inodes, pids) => mapSocketOwners(inodes, pids),
    probe: probeUrl,
    emit: result => wiring.emit(SESSION_PORTS_CHANGED_EVENT, result),
    now: Date.now,
    log: wiring.log,
  });
  const cloud = record !== undefined;
  const notCloud = (): SessionPortsListResult => ({
    ok: true,
    available: false,
    unavailableReason: 'Session ports are only for Runpane Cloud Sessions',
    scheme: 'https',
    autoOpen: false,
    ports: [],
    suggested: [],
    manifests: [],
  });
  const requireCloud = () => {
    if (!cloud) throw new PaneCommandError('Session ports are only for Runpane Cloud Sessions (this daemon is not in one).', 'ERR_PORTS_UNAVAILABLE');
  };

  wiring.commandRegistry.register('runpane:ports:list', async (request: PaneCommandValue = {}) => {
    const { verify } = decodeRequest(request, listRequestSchema);
    return cloud ? service.list({ verify }) : notCloud();
  });
  wiring.commandRegistry.register('runpane:ports:open', async (request: PaneCommandValue) => {
    const decoded = decodeRequest(request, openRequestSchema);
    requireCloud();
    return service.open(decoded);
  });
  wiring.commandRegistry.register('runpane:ports:close', async (request: PaneCommandValue) => {
    const { target } = decodeRequest(request, closeRequestSchema);
    requireCloud();
    return service.close(target);
  });
  wiring.commandRegistry.register('runpane:ports:configure', async (request: PaneCommandValue) => {
    const { autoOpen } = decodeRequest(request, configureRequestSchema);
    requireCloud();
    return service.configure({ autoOpen });
  });

  if (!cloud || process.platform !== 'linux') return undefined;
  service.start();
  return service;
}
