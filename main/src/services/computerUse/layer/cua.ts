/**
 * The `cua` object agent scripts use: Codex's `cua.getApp()` and app-bound verbs, over any engine
 * behind a `DesktopDriver`. It adds stable element ids and diffs, settling after each action,
 * honest background refusals with an opt-in foreground retry, and a screenshot per step.
 */
import type { JsonObject, JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineImage } from '../engine';
import {
  WindowGoneError,
  type ActionOutcome,
  type ActionTarget,
  type AppInfo,
  type DesktopDriver,
  type DriverAction,
  type Point,
  type StepRecord,
  type WindowInfo,
  type WindowSnapshot,
} from './driver';
import { WindowTree } from './tree';

export interface LayerHost {
  driver: DesktopDriver;
  /** Adds text to the script's result. */
  write(text: string): void;
  /** Adds an image to the script's result. */
  emitImage(image: EngineImage): void;
  /** Persists one step; absent where nothing records runs. */
  recordStep?(step: StepRecord): void;
  /** Tells the user an app is about to come forward. Resolves with a line for the result, if any. */
  showForegroundNotice(info: { app: string; action: string }): Promise<string | undefined>;
  /** Wait after each action before reading again. */
  settleMs?: number;
  /** Longest extra wait while the app reports busy or loading. */
  busyTimeoutMs?: number;
  busyPollMs?: number;
  launchTimeoutMs?: number;
}

type Vec2 = [x: number, y: number];
type Direction = 'up' | 'down' | 'left' | 'right' | 'u' | 'd' | 'l' | 'r';
type MouseButton = 'left' | 'right' | 'middle' | 'l' | 'r' | 'm';
interface ForegroundOption { foreground?: boolean }
interface ObservationOptions { emit?: boolean }
interface StateOptions extends ObservationOptions { disableDiffing?: boolean; disableDiff?: boolean }

const DEFAULT_SETTLE_MS = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_BUSY_POLL_MS = 250;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
/** Paste can't see when the app has read the clipboard, so it waits this long before restoring it. */
const PASTE_RESTORE_DELAY_MS = 500;
const PIXELS_PER_SCROLL_LINE = 40;

/** How each verb reads in the needs_foreground copy: "<App> can't receive <noun> in the background". */
const ACTION_NOUNS: Record<string, string> = {
  click: 'clicks',
  scroll: 'scrolling',
  drag: 'drags',
  typeText: 'typing',
  pressKey: 'key presses',
  paste: 'pastes',
  setValue: 'value changes',
  selectText: 'text selection',
  performSecondaryAction: 'that action',
};

export function needsForegroundMessage(app: string, verb: string): string {
  return `needs_foreground: ${app} can't receive ${ACTION_NOUNS[verb] ?? verb} in the background on this OS. Retry with { foreground: true } to bring it to the front; the user will see a notice first.`;
}

export function createCua(host: LayerHost) {
  const { driver } = host;
  const settleMs = host.settleMs ?? DEFAULT_SETTLE_MS;
  const busyTimeoutMs = host.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const busyPollMs = host.busyPollMs ?? DEFAULT_BUSY_POLL_MS;
  const launchTimeoutMs = host.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  /** One tree per window, shared by every App bound to it, so ids hold across getApp calls and scripts. */
  const trees = new Map<number, WindowTree>();
  let nextStep = 0;

  const treeFor = (windowId: number) => {
    let tree = trees.get(windowId);
    if (!tree) {
      tree = new WindowTree();
      trees.set(windowId, tree);
    }
    return tree;
  };

  /** The window an agent most likely means: on screen, frontmost, titled. */
  function mainWindow(windows: WindowInfo[]): WindowInfo | undefined {
    const score = (w: WindowInfo) => [w.onScreen === false ? 0 : 1, w.zIndex ?? -1, w.title ? 1 : 0];
    return [...windows].sort((a, b) => {
      const [sa, sb] = [score(a), score(b)];
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
      return 0;
    })[0];
  }

  async function waitForWindow(pid: number | undefined, name: string): Promise<WindowInfo | undefined> {
    const deadline = Date.now() + launchTimeoutMs;
    for (;;) {
      const windows = pid !== undefined ? await driver.listWindows(pid) : (await driver.listWindows()).filter((w) => w.app === name);
      const window = mainWindow(windows);
      if (window || Date.now() >= deadline) return window;
      await sleep(busyPollMs);
    }
  }

  class App {
    private window: WindowInfo;

    constructor(window: WindowInfo, readonly name: string) {
      this.window = window;
    }

    get windowId(): number {
      return this.window.id;
    }

    get pid(): number {
      return this.window.pid;
    }

    // --- Observation

    async getAXState(options: StateOptions = {}): Promise<string> {
      const snapshot = await this.read({ screenshot: false });
      const tree = treeFor(this.window.id);
      const body = tree.render({ full: options.disableDiffing === true || options.disableDiff === true });
      const text = `${this.header(snapshot)}\n${body}`;
      if (options.emit !== false) host.write(text);
      return text;
    }

    async getScreenshot(options: ObservationOptions = {}): Promise<EngineImage> {
      const snapshot = await this.read({ screenshot: true, tree: false });
      if (!snapshot.screenshot) throw new Error(`${this.name} returned no screenshot. Screen Recording may be off for the engine.`);
      if (options.emit !== false) host.emitImage(snapshot.screenshot);
      return snapshot.screenshot;
    }

    async getAXStateAndScreenshot(options: StateOptions = {}): Promise<{ state: string; screenshot?: EngineImage }> {
      const snapshot = await this.read({ screenshot: true });
      const body = treeFor(this.window.id).render({ full: options.disableDiffing === true || options.disableDiff === true });
      const state = `${this.header(snapshot)}\n${body}`;
      if (options.emit !== false) {
        host.write(state);
        if (snapshot.screenshot) host.emitImage(snapshot.screenshot);
      }
      return { state, screenshot: snapshot.screenshot };
    }

    // --- Actions

    click(target: number | Vec2, options: ForegroundOption & { mouseButton?: MouseButton; clickCount?: number } = {}): Promise<void> {
      const button = normalizeButton(options.mouseButton);
      const count = options.clickCount ?? 1;
      return this.act('click', { target: targetArg(target), button, clickCount: count }, options, () =>
        this.perform({ kind: 'click', target: this.resolveTarget(target), button, count }, options),
      );
    }

    scroll(target: number | Vec2, direction: Direction, distance?: number | { pixels: number }, options: ForegroundOption = {}): Promise<void> {
      const dir = normalizeDirection(direction);
      const byPixels = typeof distance === 'object' && distance !== null;
      const amount = byPixels ? Math.max(1, Math.round(distance.pixels / PIXELS_PER_SCROLL_LINE)) : Math.max(1, Math.round(distance ?? 1));
      const args: JsonObject = { target: targetArg(target), direction: dir, ...(byPixels ? { pixels: distance.pixels } : { pages: amount }) };
      return this.act('scroll', args, options, () =>
        this.perform({ kind: 'scroll', target: this.resolveTarget(target), direction: dir, amount, by: byPixels ? 'line' : 'page' }, options),
      );
    }

    drag(from: Vec2, to: Vec2, options: ForegroundOption = {}): Promise<void> {
      return this.act('drag', { from: [...from], to: [...to] }, options, () =>
        this.perform({ kind: 'drag', from: toPoint(from), to: toPoint(to) }, options),
      );
    }

    /** Types into the focused element. Each `\n` presses Return. */
    typeText(text: string, options: ForegroundOption = {}): Promise<void> {
      return this.act('typeText', { text }, options, async () => {
        const lines = String(text).split('\n');
        let outcome: ActionOutcome = { ok: true };
        for (const [i, line] of lines.entries()) {
          if (i > 0) outcome = await this.perform({ kind: 'pressKey', key: 'Return' }, options);
          if (outcome.ok && line) outcome = await this.perform({ kind: 'typeText', text: line }, options);
          if (!outcome.ok) return outcome;
        }
        return outcome;
      });
    }

    pressKey(key: string, options: ForegroundOption = {}): Promise<void> {
      return this.act('pressKey', { key }, options, () => this.perform({ kind: 'pressKey', key: String(key) }, options));
    }

    setValue(elementIndex: number, value: string, options: ForegroundOption = {}): Promise<void> {
      return this.act('setValue', { elementIndex, value }, options, () =>
        this.perform({ kind: 'setValue', ref: this.refFor(elementIndex), value: String(value) }, options),
      );
    }

    selectText(
      elementIndex: number,
      text: string,
      options: ForegroundOption & { prefix?: string; suffix?: string; selectionType?: 'text' | 'cursor_before' | 'cursor_after' } = {},
    ): Promise<void> {
      const { prefix = '', suffix = '', selectionType = 'text' } = options;
      return this.act('selectText', { elementIndex, text, prefix, suffix, selectionType }, options, async () => {
        const ref = this.refFor(elementIndex);
        const value = treeFor(this.window.id).valueFor(elementIndex) ?? '';
        const at = findText(value, String(text), prefix, suffix);
        if (at === undefined) return { ok: false, needsForeground: false, message: `Element ${elementIndex} doesn't contain ${JSON.stringify(text)}${prefix || suffix ? ' with that prefix and suffix' : ''}.` };
        const start = selectionType === 'cursor_after' ? at + text.length : at;
        const length = selectionType === 'text' ? text.length : 0;
        return this.perform({ kind: 'selectText', ref, start, length }, options);
      });
    }

    performSecondaryAction(elementIndex: number, action: string, options: ForegroundOption = {}): Promise<void> {
      return this.act('performSecondaryAction', { elementIndex, action }, options, () =>
        this.perform({ kind: 'secondaryAction', ref: this.refFor(elementIndex), action: String(action) }, options),
      );
    }

    /** Pastes into the focused element, then puts the user's clipboard back. */
    paste(text: string, options: ForegroundOption & { format?: 'text' | 'md' | 'html' } = {}): Promise<void> {
      const format = options.format ?? 'text';
      return this.act('paste', { text, format }, options, async () => {
        if (format === 'html') return { ok: false, needsForeground: false, message: "This engine can't paste HTML yet. Paste it as text or md." };
        const saved = await driver.readClipboard();
        if (!saved.restorable) {
          // Pasting would lose what the user copied, so type the text instead.
          const typed = await this.perform({ kind: 'typeText', text: String(text) }, options);
          return typed.ok ? { ok: true, note: "typed instead of pasting, because the user's clipboard holds content that can't be restored" } : typed;
        }
        await driver.writeClipboard(String(text));
        try {
          return await this.perform({ kind: 'pressKey', key: driver.platform === 'mac' ? 'super+v' : 'ctrl+v' }, options);
        } finally {
          await sleep(PASTE_RESTORE_DELAY_MS);
          await driver.writeClipboard(saved.text ?? '');
        }
      });
    }

    // --- Internals

    private header(snapshot: WindowSnapshot): string {
      const title = snapshot.title ?? this.window.title;
      return `${this.name}${title ? ` · ${JSON.stringify(title)}` : ''} · window ${this.window.id}`;
    }

    private refFor(elementIndex: number): string {
      const ref = treeFor(this.window.id).refFor(Number(elementIndex));
      if (ref === undefined) throw new Error(`Element ${elementIndex} isn't in ${this.name}'s window now. Call getAXState() and use an id from it.`);
      return ref;
    }

    private resolveTarget(target: number | Vec2): ActionTarget {
      return typeof target === 'number' ? { ref: this.refFor(target) } : toPoint(target);
    }

    private async perform(action: DriverAction, options: ForegroundOption): Promise<ActionOutcome> {
      return driver.perform(this.window, action, { foreground: options.foreground === true });
    }

    /**
     * Runs one action: the notice first when it may bring the app forward, then the action, a settle
     * and a step record. Throws the needs_foreground copy or the engine's message when it fails.
     */
    private async act(verb: string, args: JsonObject, options: ForegroundOption, run: () => Promise<ActionOutcome>): Promise<void> {
      const at = new Date().toISOString();
      const index = nextStep++;
      const stepArgs: JsonObject = { app: this.name, windowId: this.window.id, ...args, ...(options.foreground ? { foreground: true } : {}) };
      let failure: Error | undefined;
      let result: JsonValue = 'ok';
      try {
        if (options.foreground) {
          const notice = await host.showForegroundNotice({ app: this.name, action: verb });
          if (notice) host.write(notice);
        }
        const outcome = await run();
        if (outcome.ok) {
          if (outcome.note) result = `ok: ${outcome.note}`;
        } else {
          failure = new Error(outcome.needsForeground ? needsForegroundMessage(this.name, verb) : outcome.message);
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      if (failure) result = failure.message;
      // A failed action changed nothing to wait for; still capture what the window shows.
      const screenshot = await this.settle(!failure).catch(() => undefined);
      host.recordStep?.({
        index,
        action: verb,
        args: stepArgs,
        result,
        ...(screenshot?.mime === 'image/png' ? { screenshotPng: screenshot.base64 } : {}),
        at,
      });
      if (failure) throw failure;
    }

    /** Waits for the app to settle after an action and returns the window's screenshot. */
    private async settle(wait: boolean): Promise<EngineImage | undefined> {
      if (wait) await sleep(settleMs);
      return (await this.read({ screenshot: true })).screenshot;
    }

    /** Reads the window, waiting up to the busy timeout while it reports busy or loading. */
    private async read(options: { screenshot: boolean; tree?: boolean }): Promise<WindowSnapshot> {
      const tree = options.tree !== false;
      const deadline = Date.now() + busyTimeoutMs;
      for (;;) {
        const snapshot = await this.readOnce({ tree, screenshot: options.screenshot });
        if (tree) treeFor(this.window.id).update(snapshot.elements);
        if (!tree || !snapshot.busy || Date.now() >= deadline) return snapshot;
        await sleep(busyPollMs);
      }
    }

    /** Reads once; when the window closed, follows the app to its main window. */
    private async readOnce(options: { tree: boolean; screenshot: boolean }): Promise<WindowSnapshot> {
      try {
        return await driver.readWindow(this.window, options);
      } catch (error) {
        if (!(error instanceof WindowGoneError)) throw error;
        const next = mainWindow(await driver.listWindows(this.window.pid));
        if (!next) throw new Error(`${this.name} has no open window now.`);
        this.window = next;
        return driver.readWindow(this.window, options);
      }
    }
  }

  async function listApps(options: ObservationOptions = {}): Promise<AppInfo[]> {
    const apps = await driver.listApps();
    if (options.emit !== false) {
      host.write(apps.map((a) => `${a.displayName ?? a.id}${a.displayName && a.displayName !== a.id ? ` (${a.id})` : ''}${a.isRunning ? ' · running' : ''}`).join('\n'));
    }
    return apps;
  }

  async function listWindows(options: ObservationOptions = {}): Promise<Array<{ id: number; app: string; title?: string }>> {
    const windows = (await driver.listWindows()).map(({ id, app, title }) => ({ id, app, ...(title ? { title } : {}) }));
    if (options.emit !== false) host.write(windows.map((w) => `${w.id} ${w.app}${w.title ? ` ${JSON.stringify(w.title)}` : ''}`).join('\n'));
    return windows;
  }

  /** Binds an app by display name, bundle id or path (launching it in the background), or a window by id. */
  async function getApp(target: string | { windowId: number }): Promise<App> {
    let window: WindowInfo | undefined;
    let name: string;
    if (typeof target === 'object' && target !== null) {
      window = (await driver.listWindows()).find((w) => w.id === Number(target.windowId));
      if (!window) throw new Error(`No open window has id ${target.windowId}. cua.listWindows() lists them.`);
      name = window.app;
    } else {
      const wanted = String(target);
      const apps = await driver.listApps();
      const lower = wanted.toLowerCase();
      const app = apps.find((a) => a.id === wanted) ?? apps.find((a) => a.displayName?.toLowerCase() === lower) ?? apps.find((a) => a.id.toLowerCase() === lower);
      if (!app) throw new Error(`No app matches ${JSON.stringify(wanted)}. cua.listApps() lists them.`);
      name = app.displayName ?? app.id;
      let pid = app.isRunning ? app.pid : undefined;
      if (!app.isRunning) pid = (await driver.launchApp(app)) ?? pid;
      window = await waitForWindow(pid, name);
      if (!window) throw new Error(`${name} has no open window.`);
    }
    const app = new App(window, name);
    await app.getAXState();
    return app;
  }

  return {
    getApp,
    listApps,
    listWindows,
    computer: { target: driver.platform },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPoint(value: Vec2): Point {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError('Pass a point as [x, y] in screenshot pixels.');
  return { x: Number(value[0]), y: Number(value[1]) };
}

function targetArg(target: number | Vec2): JsonValue {
  return typeof target === 'number' ? target : [...toPointArray(target)];
}

function toPointArray(target: Vec2): number[] {
  const { x, y } = toPoint(target);
  return [x, y];
}

function normalizeButton(button: MouseButton | undefined): 'left' | 'right' | 'middle' {
  if (button === 'r' || button === 'right') return 'right';
  if (button === 'm' || button === 'middle') return 'middle';
  return 'left';
}

function normalizeDirection(direction: Direction): 'up' | 'down' | 'left' | 'right' {
  const map: Record<string, 'up' | 'down' | 'left' | 'right'> = { u: 'up', d: 'down', l: 'left', r: 'right', up: 'up', down: 'down', left: 'left', right: 'right' };
  const dir = map[String(direction)];
  if (!dir) throw new TypeError(`Scroll direction must be up, down, left or right, not ${JSON.stringify(direction)}.`);
  return dir;
}

/** Where `text` starts in `value`, honoring an optional prefix and suffix around it. */
function findText(value: string, text: string, prefix: string, suffix: string): number | undefined {
  const needle = `${prefix}${text}${suffix}`;
  const at = value.indexOf(needle);
  return at === -1 ? undefined : at + prefix.length;
}

export type Cua = ReturnType<typeof createCua>;
