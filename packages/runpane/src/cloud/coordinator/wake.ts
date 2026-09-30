import { findDirectoryEntry } from './directory';
import { describeError } from './daemonProbe';
import { BoatProviderError } from './boatProvider';
import type { RunawayGuard, SandboxActivity } from './guards';
import { isManagedSandbox } from './guards';
import type {
  AlertSink,
  Clock,
  CoordinatorProvider,
  DaemonHealth,
  DaemonProbe,
  DirectoryEntry,
  ProviderSandbox,
  SessionDirectory,
} from './types';

/** final-plan's four statuses plus `awake`, the success answer once /health is ready. */
export type CloudHostStatus = 'awake' | 'asleep' | 'waking' | 'daemon-down' | 'lost';

export interface CloudHostReport {
  ok: true;
  host: string;
  label: string;
  sandboxId: string;
  status: CloudHostStatus;
  baseUrl: string;
  version: string | null;
  detail: string;
}

export type WakeFailureCode =
  | 'unknown-host'
  | 'directory-unreadable'
  | 'runaway-guard'
  | 'wake-rate-limited'
  | 'provider-error';

export interface WakeFailure {
  ok: false;
  code: WakeFailureCode;
  message: string;
}

export type WakeResult = CloudHostReport | WakeFailure;

export interface WakeOptions {
  managedNamePrefix: string;
  selfSandboxId: string | null;
  ignoreSandboxIds: readonly string[];
  pinnedVersion: string | null;
  pinnedDebUrl: string | null;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  daemonDownGraceMs: number;
  pollIntervalMs: number;
  upgradeTimeoutMs: number;
}

const STOPPING_WAIT_MS = 60_000;

export class WakeService {
  private readonly inflight = new Map<string, Promise<WakeResult>>();

  constructor(
    private readonly deps: {
      directory: SessionDirectory;
      provider: CoordinatorProvider;
      probe: DaemonProbe;
      activity: SandboxActivity;
      guard: RunawayGuard;
      alerts: AlertSink;
      clock: Clock;
    },
    private readonly options: WakeOptions,
  ) {}

  /** Reports a host's status without waking it (for workspace:wait / panels:list against a peer). */
  async status(host: string): Promise<WakeResult> {
    const resolved = await this.resolve(host);
    if (!resolved.ok) return resolved;
    try {
      const sandbox = await this.deps.provider.get(resolved.entry.sandboxId);
      return await this.classify(resolved.entry, sandbox);
    } catch (error) {
      return { ok: false, code: 'provider-error', message: describeError(error) };
    }
  }

  /**
   * Wakes a host: resumes its sandbox if it is asleep and, with `wait`, returns once the daemon's
   * /health reports ready (then applies the pinned version). Concurrent wakes of one sandbox share
   * a single resume.
   */
  async wake(host: string, request: { wait: boolean; timeoutMs?: number }): Promise<WakeResult> {
    const resolved = await this.resolve(host);
    if (!resolved.ok) return resolved;
    const { entry } = resolved;
    // Any wake request counts as activity: idle-stop leaves the sandbox alone for the grace period.
    this.deps.activity.markWoken(entry.sandboxId);
    const timeoutMs = Math.min(request.timeoutMs ?? this.options.defaultTimeoutMs, this.options.maxTimeoutMs);
    const existing = this.inflight.get(entry.sandboxId);
    if (existing) {
      return request.wait ? existing : this.status(entry.sessionId);
    }
    const run = this.runWake(entry, request.wait, timeoutMs).finally(() => {
      this.inflight.delete(entry.sandboxId);
    });
    this.inflight.set(entry.sandboxId, run);
    return run;
  }

  private async runWake(entry: DirectoryEntry, wait: boolean, timeoutMs: number): Promise<WakeResult> {
    const deadline = this.deps.clock.now() + timeoutMs;
    let sandbox: ProviderSandbox;
    try {
      sandbox = await this.deps.provider.get(entry.sandboxId);
      if (sandbox.state === 'stopping') sandbox = await this.waitWhileStopping(entry.sandboxId);
    } catch (error) {
      return { ok: false, code: 'provider-error', message: describeError(error) };
    }

    if (sandbox.state === 'stopped') {
      const resumed = await this.resume(entry);
      if (resumed) return resumed;
      if (!wait) return this.report(entry, 'waking', null, 'resume requested');
    } else if (sandbox.state === 'missing' || sandbox.state === 'failed') {
      return this.classify(entry, sandbox);
    }

    let last: CloudHostReport | null = null;
    while (this.deps.clock.now() < deadline) {
      let current: ProviderSandbox;
      try {
        current = await this.deps.provider.get(entry.sandboxId);
      } catch (error) {
        return { ok: false, code: 'provider-error', message: describeError(error) };
      }
      last = await this.classify(entry, current);
      if (last.status === 'awake' || last.status === 'lost') break;
      if (!wait && last.status !== 'asleep') return last;
      await this.deps.clock.sleep(this.options.pollIntervalMs);
    }
    if (!last) return this.status(entry.sessionId);
    if (last.status !== 'awake') {
      last.detail = `timed out after ${timeoutMs} ms: ${last.detail}`;
      return last;
    }
    this.deps.activity.markWoken(entry.sandboxId);
    return this.applyPinnedVersion(entry, last, deadline);
  }

  private async resume(entry: DirectoryEntry): Promise<WakeFailure | null> {
    let managed: ProviderSandbox[];
    try {
      managed = (await this.deps.provider.list()).filter((sandbox) => isManagedSandbox(sandbox, this.options));
    } catch (error) {
      return { ok: false, code: 'provider-error', message: describeError(error) };
    }
    const verdict = this.deps.guard.checkResume(entry.sandboxId, managed);
    if (!verdict.ok) {
      this.deps.alerts.emit({
        level: 'error',
        code: verdict.code,
        message: `${entry.label}: ${verdict.message}`,
        sandboxId: entry.sandboxId,
        sessionId: entry.sessionId,
      });
      return { ok: false, code: verdict.code, message: verdict.message };
    }
    const minute = Math.floor(this.deps.clock.now() / 60_000);
    // Idle-stop may hold the sandbox for a few seconds; wait for it rather than racing its stop call.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const outcome = await this.deps.activity.exclusive(entry.sandboxId, async () => {
        await this.deps.provider.resume(entry.sandboxId, `rpc-wake-${entry.sandboxId}-${minute}`);
      }).catch((error: unknown) => ({ ran: true as const, error }));
      if (!outcome.ran) {
        await this.deps.clock.sleep(500);
        continue;
      }
      if ('error' in outcome) {
        const error = outcome.error;
        // 409: a resume is already in progress; the readiness loop picks it up.
        if (error instanceof BoatProviderError && error.status === 409) return null;
        return { ok: false, code: 'provider-error', message: describeError(error) };
      }
      this.deps.guard.recordResume(entry.sandboxId);
      this.deps.activity.markWoken(entry.sandboxId);
      this.deps.alerts.emit({
        level: 'info',
        code: 'woken',
        message: `${entry.label}: resume requested`,
        sandboxId: entry.sandboxId,
        sessionId: entry.sessionId,
      });
      return null;
    }
    return { ok: false, code: 'provider-error', message: 'sandbox stayed busy; resume not sent' };
  }

  private async waitWhileStopping(sandboxId: string): Promise<ProviderSandbox> {
    const until = this.deps.clock.now() + STOPPING_WAIT_MS;
    let sandbox = await this.deps.provider.get(sandboxId);
    while (sandbox.state === 'stopping' && this.deps.clock.now() < until) {
      await this.deps.clock.sleep(this.options.pollIntervalMs);
      sandbox = await this.deps.provider.get(sandboxId);
    }
    return sandbox;
  }

  private async applyPinnedVersion(entry: DirectoryEntry, report: CloudHostReport, deadline: number): Promise<CloudHostReport> {
    const pinned = entry.pinnedVersion ?? this.options.pinnedVersion;
    if (!pinned || report.version === pinned) return report;
    if (!entry.coordinatorToken) {
      report.detail = `version-mismatch: running ${report.version ?? 'unknown'}, pinned ${pinned} (no coordinator token)`;
      return report;
    }
    const answer = await this.deps.probe.upgrade(entry.baseUrl, entry.coordinatorToken, pinned, this.options.pinnedDebUrl);
    if (answer.kind !== 'started') {
      report.detail = `version-mismatch: running ${report.version ?? 'unknown'}, pinned ${pinned}; upgrade ${answer.kind}: ${answer.error}`;
      this.deps.alerts.emit({
        level: 'warn',
        code: 'version-mismatch',
        message: `${entry.label}: ${report.detail}`,
        sandboxId: entry.sandboxId,
        sessionId: entry.sessionId,
      });
      return report;
    }
    const upgradeDeadline = Math.max(deadline, this.deps.clock.now() + this.options.upgradeTimeoutMs);
    let health: DaemonHealth = { reachable: false, error: 'not checked' };
    while (this.deps.clock.now() < upgradeDeadline) {
      await this.deps.clock.sleep(this.options.pollIntervalMs);
      health = await this.deps.probe.health(entry.baseUrl);
      if (health.reachable && health.ready && health.version === pinned) {
        return this.report(entry, 'awake', pinned, `upgraded to pinned ${pinned}`);
      }
    }
    const status: CloudHostStatus = health.reachable ? 'waking' : 'daemon-down';
    return this.report(entry, status, health.reachable ? health.version : null, `upgrade to ${pinned} did not finish in time`);
  }

  private async classify(entry: DirectoryEntry, sandbox: ProviderSandbox): Promise<CloudHostReport> {
    switch (sandbox.state) {
      case 'missing':
      case 'failed':
        return this.report(entry, 'lost', null, `provider state ${sandbox.rawState}`);
      case 'stopped':
      case 'stopping':
        return this.report(entry, 'asleep', null, `provider state ${sandbox.rawState}`);
      case 'starting':
        return this.report(entry, 'waking', null, `provider state ${sandbox.rawState}`);
      case 'running':
        break;
    }
    const health = await this.deps.probe.health(entry.baseUrl);
    if (health.reachable && health.ready) return this.report(entry, 'awake', health.version, 'daemon ready');
    const sinceUp = this.deps.activity.msSinceWoken(entry.sandboxId)
      ?? (sandbox.updatedAt ? this.deps.clock.now() - Date.parse(sandbox.updatedAt) : null);
    const grace = health.reachable ? this.options.daemonDownGraceMs * 2 : this.options.daemonDownGraceMs;
    const withinGrace = sinceUp !== null && Number.isFinite(sinceUp) && sinceUp < grace;
    const detail = health.reachable ? 'daemon answers but is not ready' : `daemon /health: ${health.error}`;
    return this.report(entry, withinGrace ? 'waking' : 'daemon-down', health.reachable ? health.version : null, detail);
  }

  private report(entry: DirectoryEntry, status: CloudHostStatus, version: string | null, detail: string): CloudHostReport {
    return {
      ok: true,
      host: entry.sessionId,
      label: entry.label,
      sandboxId: entry.sandboxId,
      status,
      baseUrl: entry.baseUrl,
      version,
      detail,
    };
  }

  private async resolve(host: string): Promise<{ ok: true; entry: DirectoryEntry } | WakeFailure> {
    const directory = await this.deps.directory.read();
    if (!directory.ok) return { ok: false, code: 'directory-unreadable', message: directory.error };
    const entry = findDirectoryEntry(directory.entries, host);
    if (!entry) return { ok: false, code: 'unknown-host', message: `no cloud Session "${host}" in the directory` };
    return { ok: true, entry };
  }
}
