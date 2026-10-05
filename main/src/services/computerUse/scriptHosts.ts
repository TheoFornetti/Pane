import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { ComputerUseEngine, EngineImage, EngineResult } from './engine';
import { childMessageSchema, type ChildMessage, type ParentMessage } from './scriptHostProtocol';

export interface ScriptRunResult {
  ok: boolean;
  text: string;
  images: EngineImage[];
}

export interface ScriptHostSummary {
  connectionId: string;
  running: boolean;
  lastUsedAt: string;
}

interface ScriptHostsOptions {
  getEngine: () => ComputerUseEngine;
  /** Shows the user that an agent is bringing `app` to the front. Resolves with a line for the result. */
  showForegroundNotice?: (info: { connectionId: string; app: string }) => Promise<string | undefined>;
  /** The compiled child next to this file; tests point it at the TypeScript source. */
  childEntry?: string;
  idleTimeoutMs?: number;
  runTimeoutMs?: number;
  maxOutputChars?: number;
}

// Starting values from the plan: Codex caps output near 25k tokens (~4 characters each).
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const GLOBAL_LANE = 'global';
const STOPPED: EngineResult = { ok: false, error: { code: 'script_stopped', message: 'The script was stopped before this call ran.' } };

// Script processes die with the daemon, even one stuck in a loop that never sees the IPC disconnect.
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackChild(child: ChildProcess): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const live of liveChildren) live.kill('SIGKILL');
    });
  }
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
}

interface Host {
  child: ChildProcess;
  /** Runs on one connection go one at a time, in order. */
  queue: Promise<unknown>;
  running: boolean;
  closed: boolean;
  lastUsedAt: Date;
  idleTimer?: ReturnType<typeof setTimeout>;
  finishRun?: (result: ScriptRunResult) => void;
  onStep?: (step: JsonValue) => void;
}

/**
 * One script process per agent connection, created on its first run and closed on reset, after
 * sitting idle, or by `stopAll`. Engine calls from every host share one lane per target app, so
 * two agents never interleave input into the same window, while different apps run in parallel.
 */
export class ScriptHosts {
  private readonly hosts = new Map<string, Host>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private nextRunId = 1;
  private readonly childEntry: string;
  private readonly idleTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(private readonly options: ScriptHostsOptions) {
    this.childEntry = options.childEntry ?? path.join(__dirname, 'scriptHostChild.js');
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  /** `onStep` gets each step the script reports while this run is in flight. */
  run(connectionId: string, code: string, onStep?: (step: JsonValue) => void): Promise<ScriptRunResult> {
    const host = this.hosts.get(connectionId) ?? this.startHost(connectionId);
    const result = host.queue.then(() => this.runOnHost(connectionId, host, code, onStep));
    host.queue = result.catch(() => undefined);
    return result;
  }

  /** Discards a connection's script state. Returns whether it had any. */
  reset(connectionId: string): boolean {
    const host = this.hosts.get(connectionId);
    if (!host) return false;
    this.closeHost(connectionId, host, 'The script state was reset while this script ran.');
    return true;
  }

  summaries(): ScriptHostSummary[] {
    return [...this.hosts].map(([connectionId, host]) => ({
      connectionId,
      running: host.running,
      lastUsedAt: host.lastUsedAt.toISOString(),
    }));
  }

  /** Stops every script and the engine, as when computer use is turned off. */
  async stopAll(reason: string): Promise<void> {
    for (const [connectionId, host] of [...this.hosts]) this.closeHost(connectionId, host, reason);
    await this.options.getEngine().stop();
  }

  private startHost(connectionId: string): Host {
    // The child gets no inherited environment or flags: it reaches the machine only through the engine.
    const child = fork(this.childEntry, [], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    trackChild(child);
    const host: Host = { child, queue: Promise.resolve(), running: false, closed: false, lastUsedAt: new Date() };
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      console.error(`[computer-use script ${connectionId}] ${chunk.trimEnd()}`);
    });
    child.on('message', (message: JsonValue) => {
      // The script can reach `process.send`, so its messages are parsed like any other untrusted input.
      const parsed = decodeOptionalBoundary(message, childMessageSchema);
      if (parsed) this.onChildMessage(connectionId, host, parsed);
      else this.closeHost(connectionId, host, 'The script process sent a malformed message and was stopped.');
    });
    // A failed fork or a send on a closed channel lands here; unhandled, it would take down the daemon.
    child.on('error', (error) => {
      console.error(`[computer-use script ${connectionId}] ${error.message}`);
      this.closeHost(connectionId, host, `The script process failed: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      host.closed = true;
      if (this.hosts.get(connectionId) === host) this.hosts.delete(connectionId);
      if (host.idleTimer) clearTimeout(host.idleTimer);
      host.finishRun?.({ ok: false, text: `The script process exited (${signal ?? `code ${code}`}); its state was lost.`, images: [] });
    });
    this.hosts.set(connectionId, host);
    return host;
  }

  private runOnHost(connectionId: string, host: Host, code: string, onStep?: (step: JsonValue) => void): Promise<ScriptRunResult> {
    if (host.closed) {
      return Promise.resolve({ ok: false, text: 'The script state was reset before this script ran.', images: [] });
    }
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.running = true;
    host.onStep = onStep;
    host.lastUsedAt = new Date();
    const runId = this.nextRunId++;
    return new Promise<ScriptRunResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.closeHost(connectionId, host, `The script ran longer than ${Math.round(this.runTimeoutMs / 1000)} s and was stopped; its state was reset.`);
      }, this.runTimeoutMs);
      host.finishRun = (result) => {
        clearTimeout(timeout);
        host.finishRun = undefined;
        host.onStep = undefined;
        host.running = false;
        host.lastUsedAt = new Date();
        if (this.hosts.get(connectionId) === host) {
          host.idleTimer = setTimeout(() => this.closeHost(connectionId, host, ''), this.idleTimeoutMs);
        }
        resolve(result);
      };
      host.child.send({ type: 'run', runId, code, maxOutputChars: this.maxOutputChars, engine: this.options.getEngine().id } satisfies ParentMessage);
    });
  }

  private onChildMessage(connectionId: string, host: Host, message: ChildMessage): void {
    if (message.type === 'done') {
      host.finishRun?.({ ok: message.ok, text: message.text, images: message.images });
      return;
    }
    if (message.type === 'step') {
      host.onStep?.(message.step);
      return;
    }
    if (message.type === 'foregroundNotice') {
      void this.showForegroundNotice(connectionId, message.app).then((text) => {
        if (!host.closed) host.child.send({ type: 'foregroundNoticeShown', noticeId: message.noticeId, text } satisfies ParentMessage);
      });
      return;
    }
    // A call queued behind others must not act once its script was stopped, reset, or turned off.
    const call = () => (host.closed ? Promise.resolve(STOPPED) : this.callEngine(message.tool, message.args));
    void this.inLane(laneFor(message.args), call).then((result) => {
      if (!host.closed) host.child.send({ type: 'callResult', callId: message.callId, result } satisfies ParentMessage);
    });
  }

  /** A failed notice never blocks the action the agent opted into; it's logged instead. */
  private async showForegroundNotice(connectionId: string, app: string): Promise<string | undefined> {
    try {
      return await this.options.showForegroundNotice?.({ connectionId, app });
    } catch (error) {
      console.error('[computer-use] Failed to show the foreground notice:', error);
      return undefined;
    }
  }

  private async callEngine(tool: string, args: JsonObject): Promise<EngineResult> {
    try {
      return await this.options.getEngine().call(tool, args);
    } catch (error) {
      return { ok: false, error: { code: 'engine_error', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private inLane<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => undefined);
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return result;
  }

  private closeHost(connectionId: string, host: Host, reason: string): void {
    host.closed = true;
    if (this.hosts.get(connectionId) === host) this.hosts.delete(connectionId);
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.finishRun?.({ ok: false, text: reason, images: [] });
    host.child.kill();
  }
}

/** Cua names the app by `pid`, the Codex runtime by `app` or `window_id`; calls without one share a lane. */
function laneFor(args: JsonObject): string {
  const pid = decodeOptionalBoundary(args.pid, boundary.number);
  if (pid !== undefined) return `pid:${pid}`;
  const app = decodeOptionalBoundary(args.app, boundary.string);
  if (app !== undefined) return `app:${app}`;
  const windowId = decodeOptionalBoundary(args.window_id, boundary.number);
  return windowId === undefined ? GLOBAL_LANE : `window:${windowId}`;
}
