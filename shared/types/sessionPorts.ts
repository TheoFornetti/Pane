/**
 * Session ports: a local service in a Runpane Cloud Session (`127.0.0.1:<port>`) published as a
 * tailnet-only URL on the Session's own name (`https://<host>.<tailnet>.ts.net:<httpsPort>/`), through
 * Tailscale Serve. Never Funnel. The daemon owns the state (`~/.runpane-cloud/ports.json`) and the
 * channels `runpane:ports:list|open|close|configure`; clients get `runpane:ports:changed` events.
 */

/** Who published a port: a person or agent (`port open`), a repository's `.runpane/ports.json`, or auto-open. */
export type SessionPortSource = 'user' | 'manifest' | 'auto';

/** `http` only when the Session's name has no TLS certificate (Let's Encrypt limit); WireGuard still encrypts it. */
export type SessionPortScheme = 'https' | 'http';

/**
 * `serving`: Tailscale Serve has the entry. `missing`: the entry is gone (the next reconcile re-applies it).
 * `error`: it could not be applied, for example another Serve entry holds the tailnet port (see `detail`).
 */
export type SessionPortStatus = 'serving' | 'missing' | 'error';

export interface SessionPort {
  name: string;
  /** The local port the service listens on, in the Session. */
  port: number;
  /** The tailnet port of the URL (for http ports too). */
  httpsPort: number;
  url: string;
  scheme: SessionPortScheme;
  /** Path appended to the URL (the service is always mounted at `/`). */
  path: string;
  source: SessionPortSource;
  /** For `manifest` ports: the repository directory whose `.runpane/ports.json` declares it. */
  repo?: string;
  createdAt: string;
  status: SessionPortStatus;
  /** Why the port is http, or why it is not serving. */
  detail?: string;
  /** Only when the caller asked to verify: an HTTP answer came back over the URL. */
  reachable?: boolean | null;
}

/** A TCP listener started under a Pane panel that is not published. */
export interface SuggestedPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  paneId?: string;
  panelId?: string;
  detectedAt: string;
}

export interface SessionPortsManifestState {
  repo: string;
  ok: boolean;
  error?: string;
  /** Ports it declares (0 when invalid). */
  count: number;
}

export interface SessionPortsListResult {
  ok: true;
  /** False off a cloud Session (no Tailscale, or not running); the arrays are then empty. */
  available: boolean;
  unavailableReason?: string;
  /** The Session's MagicDNS name, without the trailing dot. */
  host?: string;
  /** What a new port gets: `http` when this Session's name has no TLS certificate. */
  scheme: SessionPortScheme;
  /** Publish detected ports without asking (a per-Session opt-in, default off). */
  autoOpen: boolean;
  ports: SessionPort[];
  suggested: SuggestedPort[];
  manifests: SessionPortsManifestState[];
}

export interface SessionPortOpenRequest {
  port: number;
  name?: string;
  httpsPort?: number;
  path?: string;
  /** Replace another Serve entry on the tailnet port (e.g. a plain tcp forward). */
  yes?: boolean;
  scheme?: 'auto' | SessionPortScheme;
}

export interface SessionPortOpenResult {
  ok: true;
  port: SessionPort;
  alreadyOpen: boolean;
  /** The Serve entry `yes` replaced. */
  replaced?: { httpsPort: number; was: string };
}

export interface SessionPortCloseResult {
  ok: true;
  closed: SessionPort | null;
}

export interface SessionPortsConfigureResult {
  ok: true;
  autoOpen: boolean;
}

export const SESSION_PORTS_CHANGED_EVENT = 'runpane:ports:changed';
