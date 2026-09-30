import type { Clock, ProviderSandbox } from './types';
import { isLiveState } from './types';

const HOUR_MS = 60 * 60 * 1000;

/**
 * In-memory bookkeeping shared by wake and idle-stop, so the two never act on the same sandbox at once
 * and a freshly woken sandbox is not idle-stopped before the caller that woke it gets to use it.
 * The coordinator stays stateless across restarts (v4 I15): losing this only makes it more cautious
 * for one grace period, because `wokenAt` falls back to "unknown".
 */
export class SandboxActivity {
  private readonly busy = new Set<string>();
  private readonly wokenAt = new Map<string, number>();
  private readonly safeStreak = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /** Runs `task` unless another coordinator action already holds this sandbox. */
  async exclusive<T>(sandboxId: string, task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy.has(sandboxId)) return { ran: false };
    this.busy.add(sandboxId);
    try {
      return { ran: true, value: await task() };
    } finally {
      this.busy.delete(sandboxId);
    }
  }

  isBusy(sandboxId: string): boolean {
    return this.busy.has(sandboxId);
  }

  markWoken(sandboxId: string): void {
    this.wokenAt.set(sandboxId, this.clock.now());
    this.safeStreak.delete(sandboxId);
  }

  msSinceWoken(sandboxId: string): number | null {
    const at = this.wokenAt.get(sandboxId);
    return at === undefined ? null : this.clock.now() - at;
  }

  recordSafe(sandboxId: string): number {
    const next = (this.safeStreak.get(sandboxId) ?? 0) + 1;
    this.safeStreak.set(sandboxId, next);
    return next;
  }

  resetSafe(sandboxId: string): void {
    this.safeStreak.delete(sandboxId);
  }
}

export type GuardVerdict = { ok: true } | { ok: false; code: 'runaway-guard' | 'wake-rate-limited'; message: string };

/**
 * Runaway guard: caps live cloud sandboxes (final-plan §4: 25 per user by default) and how often the
 * coordinator may resume, per sandbox and overall, so a wake loop can't burn money unnoticed.
 */
export class RunawayGuard {
  private resumes: Array<{ sandboxId: string; at: number }> = [];

  constructor(
    private readonly clock: Clock,
    private readonly limits: { maxLiveSandboxes: number; maxResumesPerSandboxPerHour: number; maxResumesPerHour: number },
  ) {}

  countLive(managed: readonly ProviderSandbox[]): number {
    return managed.filter((sandbox) => isLiveState(sandbox.state)).length;
  }

  checkLive(managed: readonly ProviderSandbox[]): GuardVerdict {
    const live = this.countLive(managed);
    if (live > this.limits.maxLiveSandboxes) {
      return {
        ok: false,
        code: 'runaway-guard',
        message: `${live} live cloud sandboxes exceeds the limit of ${this.limits.maxLiveSandboxes}`,
      };
    }
    return { ok: true };
  }

  /** Called before resuming `sandboxId`, which is currently stopped and would add one live sandbox. */
  checkResume(sandboxId: string, managed: readonly ProviderSandbox[]): GuardVerdict {
    const live = this.countLive(managed);
    if (live >= this.limits.maxLiveSandboxes) {
      return {
        ok: false,
        code: 'runaway-guard',
        message: `refusing to wake: ${live} cloud sandboxes are already live (limit ${this.limits.maxLiveSandboxes})`,
      };
    }
    this.prune();
    const forSandbox = this.resumes.filter((entry) => entry.sandboxId === sandboxId).length;
    if (forSandbox >= this.limits.maxResumesPerSandboxPerHour) {
      return {
        ok: false,
        code: 'wake-rate-limited',
        message: `${sandboxId} was resumed ${forSandbox} times in the last hour (limit ${this.limits.maxResumesPerSandboxPerHour})`,
      };
    }
    if (this.resumes.length >= this.limits.maxResumesPerHour) {
      return {
        ok: false,
        code: 'wake-rate-limited',
        message: `${this.resumes.length} resumes in the last hour (limit ${this.limits.maxResumesPerHour})`,
      };
    }
    return { ok: true };
  }

  recordResume(sandboxId: string): void {
    this.resumes.push({ sandboxId, at: this.clock.now() });
  }

  private prune(): void {
    const cutoff = this.clock.now() - HOUR_MS;
    this.resumes = this.resumes.filter((entry) => entry.at > cutoff);
  }
}

export function isManagedSandbox(
  sandbox: ProviderSandbox,
  options: { managedNamePrefix: string; selfSandboxId: string | null; ignoreSandboxIds: readonly string[] },
): boolean {
  if (sandbox.id === options.selfSandboxId) return false;
  if (options.ignoreSandboxIds.includes(sandbox.id)) return false;
  return sandbox.name.startsWith(options.managedNamePrefix);
}
