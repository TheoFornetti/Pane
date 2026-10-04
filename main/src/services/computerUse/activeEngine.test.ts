import { describe, expect, it } from 'vitest';
import type { ComputerUseEngineChoice } from '../../../../shared/types/computerUse';
import { createEngineSelector } from './activeEngine';
import type { ComputerUseEngine, EngineResult, EngineStatus } from './engine';

function engine(id: ComputerUseEngine['id'], status: Partial<EngineStatus> = {}, listApps: EngineResult = { ok: true, data: [] }) {
  const calls: string[] = [];
  let stops = 0;
  const fake: ComputerUseEngine = {
    id,
    status: async () => ({ installed: true, permissions: {}, desktopSession: true, ...status }),
    async call(tool) {
      calls.push(tool);
      return tool === 'list_apps' ? listApps : { ok: true, data: { engine: id } };
    },
    async stop() { stops += 1; },
  };
  return { fake, calls, stops: () => stops };
}

function selector(codex: ComputerUseEngine, cua: ComputerUseEngine, choice: ComputerUseEngineChoice = 'auto') {
  return createEngineSelector({ engineChoice: () => choice, codex, cua });
}

describe('engine selection', () => {
  it('runs on the Codex runtime when Auto finds it answering', async () => {
    const codex = engine('codex');
    const selected = selector(codex.fake, engine('cua-driver').fake);

    await expect(selected.status()).resolves.toEqual({ installed: true, permissions: {}, desktopSession: true });
    expect(selected.id).toBe('codex');
    await expect(selected.call('get_app_state', { app: 'TextEdit' })).resolves.toEqual({ ok: true, data: { engine: 'codex' } });
  });

  it('falls back to Cua Driver and names the reason when ChatGPT is missing', async () => {
    const selected = selector(engine('codex', { installed: false, detail: 'ChatGPT is not installed.' }).fake, engine('cua-driver').fake);

    await expect(selected.status()).resolves.toMatchObject({ installed: true, detail: 'Codex runtime not used: ChatGPT is not installed.' });
    expect(selected.id).toBe('cua-driver');
    await expect(selected.call('click', {})).resolves.toEqual({ ok: true, data: { engine: 'cua-driver' } });
  });

  it('falls back to Cua Driver when the runtime refuses calls from Pane', async () => {
    const codex = engine('codex', {}, { ok: false, error: { code: 'codex_error', message: 'Sender process is not authenticated' } });
    const selected = selector(codex.fake, engine('cua-driver').fake);

    await expect(selected.status()).resolves.toMatchObject({
      detail: 'Codex runtime not used: it refused calls from Pane (Sender process is not authenticated).',
    });
    expect(selected.id).toBe('cua-driver');
    expect(codex.stops()).toBeGreaterThan(0);
  });

  it('uses Cua Driver without trying Codex when the machine is set to Cua Driver', async () => {
    const codex = engine('codex');
    const selected = selector(codex.fake, engine('cua-driver').fake, 'cua-driver');

    await expect(selected.status()).resolves.toEqual({ installed: true, permissions: {}, desktopSession: true });
    expect(selected.id).toBe('cua-driver');
    expect(codex.calls).toEqual([]);
  });

  it('picks again on the next status, so a newly installed ChatGPT is used', async () => {
    let installed = false;
    const codex = engine('codex');
    codex.fake.status = async () => ({ installed, permissions: {}, desktopSession: true });
    const selected = selector(codex.fake, engine('cua-driver').fake);

    await selected.status();
    expect(selected.id).toBe('cua-driver');
    installed = true;
    await selected.status();
    expect(selected.id).toBe('codex');
  });
});
