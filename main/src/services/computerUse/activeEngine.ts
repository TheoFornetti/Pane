import type { ComputerUseEngineChoice } from '../../../../shared/types/computerUse';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { createCodexEngine } from './codexEngine';
import { createCuaDriverEngine } from './cuaDriver';
import type { ComputerUseEngine, EngineResult, EngineStatus } from './engine';

interface EngineSelectorOptions {
  engineChoice: () => ComputerUseEngineChoice;
  codex: ComputerUseEngine;
  cua: ComputerUseEngine;
}

/**
 * Auto runs on the user's Codex runtime when it is installed and answers Pane, else on Cua Driver
 * with the reason in `status().fallbackReason`. Each status() picks again, so readiness rechecks
 * notice ChatGPT being installed or removed; a selected runtime is kept without a new self-test,
 * so a check never stops calls in flight.
 */
class EngineSelector implements ComputerUseEngine {
  private selected: ComputerUseEngine | null = null;
  /** Bumped by stop(), so a selection that was in progress never starts an engine afterwards. */
  private generation = 0;

  constructor(private readonly options: EngineSelectorOptions) {}

  get id() {
    return (this.selected ?? this.options.cua).id;
  }

  async status(): Promise<EngineStatus> {
    const { engine, fallbackReason } = await this.select();
    const status = await engine.status();
    if (fallbackReason) status.fallbackReason = `Codex runtime not used: ${fallbackReason}`;
    return status;
  }

  async call(tool: string, args: JsonObject): Promise<EngineResult> {
    const engine = this.selected ?? (await this.select()).engine;
    return engine.call(tool, args);
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.selected = null;
    await Promise.all([this.options.codex.stop(), this.options.cua.stop()]);
  }

  private async select(): Promise<{ engine: ComputerUseEngine; fallbackReason?: string }> {
    const { codex, cua } = this.options;
    const generation = this.generation;
    if (this.options.engineChoice() === 'cua-driver') return this.use(generation, cua, codex);

    const status = await codex.status();
    if (!status.installed) return this.use(generation, cua, codex, status.detail ?? 'ChatGPT is not installed.');
    if (!status.desktopSession) return this.use(generation, cua, codex, 'no desktop session.');
    if (this.selected !== codex) {
      const test = await codex.call('list_apps', {});
      if (!test.ok) return this.use(generation, cua, codex, `it refused calls from Pane (${test.error?.message ?? 'no answer'}).`);
    }
    return this.use(generation, codex, cua);
  }

  private async use(generation: number, engine: ComputerUseEngine, other: ComputerUseEngine, fallbackReason?: string) {
    if (generation !== this.generation) {
      // Computer use stopped while this selection ran; leave nothing it started running.
      await engine.stop();
      return { engine, fallbackReason };
    }
    if (this.selected !== engine) await other.stop();
    this.selected = engine;
    return { engine, fallbackReason };
  }
}

export function createEngineSelector(options: EngineSelectorOptions): ComputerUseEngine {
  return new EngineSelector(options);
}

let engine: ComputerUseEngine | null = null;
let engineChoice: () => ComputerUseEngineChoice = () => 'auto';

/** The daemon passes the machine's saved engine choice before the first engine call. */
export function setComputerUseEngineChoice(read: () => ComputerUseEngineChoice): void {
  engineChoice = read;
}

/** The daemon's one engine instance, shared by the script hosts and readiness. */
export function getComputerUseEngine(): ComputerUseEngine {
  engine ??= createEngineSelector({ engineChoice: () => engineChoice(), codex: createCodexEngine(), cua: createCuaDriverEngine() });
  return engine;
}
