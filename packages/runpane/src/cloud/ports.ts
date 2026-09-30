import type { SandboxHandle } from './provider';
import type { CloudCredentials, PaneSource } from './store';

/**
 * What the `runpane cloud` commands need from m1-bootstrap (src/cloud/bootstrap/**, src/cloud/tailscale.ts)
 * and from the Tailscale API. The shapes follow ~/rc-loop/ledger/iface-bootstrap.md. `wiring.ts` adapts the
 * real modules to these ports, and tests pass fakes.
 */

export interface TailnetDevice {
  nodeId: string;
  hostname: string;
  /** MagicDNS name, e.g. rp-abc12345.tail03bf19.ts.net */
  name?: string;
  online?: boolean;
  lastSeen?: string;
}

export interface TailnetPort {
  findDevicesByHostname(hostname: string): Promise<TailnetDevice[]>;
  /** Resolves false (or nothing) when the device was already gone. */
  deleteDevice(nodeId: string): Promise<boolean | void>;
}

export interface ProvisionRequest {
  sessionId: string;
  label: string;
  hostname: string;
  paneSource: PaneSource;
  repo?: { url: string; ref?: string };
  /** Local 0600 file that receives the pane-remote:// code. */
  pairingOutputPath: string;
  extraClients?: { label: string; outputPath: string }[];
  healthTimeoutMs?: number;
  onStep?: (step: string) => void;
}

interface ProvisionOutcome {
  hostname: string;
  magicDnsName: string;
  nodeId: string;
  baseUrl: string;
  pairingPath: string;
  daemonVersion?: string;
  timings: Partial<Record<string, number>>;
}

interface HealthResult {
  ok: boolean;
  status?: number;
  elapsedMs: number;
  version?: string;
}

export interface BootstrapPort {
  cloudHostname(sessionId: string, prefix: string): string;
  provision(sandbox: SandboxHandle, request: ProvisionRequest, tailnet: TailnetCredentials): Promise<ProvisionOutcome>;
  waitForDaemonHealth(baseUrl: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<HealthResult>;
  createTailnet(credentials: TailnetCredentials): TailnetPort;
  /** Joins a sandbox to the tailnet as tag:rp-session without installing Pane (the coordinator's box). */
  joinTailnet(sandbox: SandboxHandle, request: JoinTailnetRequest, tailnet: TailnetCredentials): Promise<JoinedNode>;
}

interface JoinTailnetRequest {
  sessionId: string;
  hostname: string;
  onStep?: (step: string) => void;
}

interface JoinedNode {
  nodeId: string;
  magicDnsName: string;
  tailscaleIps: string[];
}

type TailnetCredentials = NonNullable<CloudCredentials['tailscale']>;
