import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineResult } from '../engine';
import { createCua } from './cua';
import { codexDriver } from './codexDriver';
import type { StepRecord } from './driver';

const SHOT = { mime: 'image/jpeg', base64: '/9j/4A==' };
const FULL = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled\n\t2 text entry area (settable) First Text View';
const DIFF = '~\t\t2 text entry area (settable) Value: hi, ID: First Text View';

/**
 * The Codex engine on macOS, as the layer sees it: app-keyed verbs, its own rendered text, a diff
 * after the first read, and a full tree on `disable_diff`.
 */
function codexMac() {
  const calls: Array<{ tool: string; args: JsonObject }> = [];
  let reads = 0;
  async function call(tool: string, args: JsonObject): Promise<EngineResult> {
    calls.push({ tool, args });
    switch (tool) {
      case 'list_apps':
        return { ok: true, data: { apps: [{ id: 'com.apple.TextEdit', displayName: 'TextEdit', isRunning: true }, { id: 'com.apple.Notes', displayName: 'Notes', isRunning: false }] } };
      case 'get_app_state':
        reads += 1;
        return { ok: true, data: { state: args.disable_diff === true || reads === 1 ? FULL : DIFF } };
      case 'screenshot':
        return { ok: true, data: {}, images: [SHOT] };
      default:
        return { ok: true, data: {} };
    }
  }
  const output: string[] = [];
  const steps: StepRecord[] = [];
  const { cua } = createCua({
    driver: codexDriver(call, 'mac'),
    write: (text) => output.push(text),
    emitImage: () => output.push('[image]'),
    recordStep: (step) => steps.push(step),
    showForegroundNotice: async () => undefined,
    // Large on purpose: a native engine settles itself, so the layer must not wait.
    settleMs: 60_000,
  });
  return { cua, calls, output, steps };
}

describe('the layer over the Codex runtime', () => {
  it("passes the runtime's own tree and diffs through, and acts by its element ids", async () => {
    const { cua, calls, output } = codexMac();

    const app = await cua.getApp('TextEdit');
    await app.typeText('hi');
    const state = await app.getAXState({ emit: false });
    const full = await app.getAXState({ emit: false, disableDiffing: true });
    await app.click(2);

    expect(output[0]).toContain(FULL);
    expect(state).toContain(DIFF);
    expect(full).toContain(FULL);
    expect(calls.filter((c) => c.tool !== 'list_apps' && c.tool !== 'screenshot')).toEqual([
      { tool: 'get_app_state', args: { app: 'com.apple.TextEdit', disable_diff: false } },
      { tool: 'type_text', args: { app: 'com.apple.TextEdit', text: 'hi' } },
      { tool: 'get_app_state', args: { app: 'com.apple.TextEdit', disable_diff: false } },
      { tool: 'get_app_state', args: { app: 'com.apple.TextEdit', disable_diff: true } },
      { tool: 'click', args: { app: 'com.apple.TextEdit', element_index: 2, mouse_button: 'left', click_count: 1 } },
    ]);
  });

  it('records each step with a screenshot, without a tree read or a settle wait', async () => {
    const { cua, calls, steps } = codexMac();
    const app = await cua.getApp('TextEdit');
    const readsBefore = calls.filter((c) => c.tool === 'get_app_state').length;

    await app.pressKey('super+n');

    expect(calls.filter((c) => c.tool === 'get_app_state')).toHaveLength(readsBefore);
    expect(steps).toEqual([expect.objectContaining({ index: 0, action: 'pressKey', result: 'ok' })]);
    expect(calls.at(-1)).toEqual({ tool: 'screenshot', args: { app: 'com.apple.TextEdit' } });
  });

  it("uses the runtime's own select_text and paste, leaving the clipboard to it", async () => {
    const { cua, calls } = codexMac();
    const app = await cua.getApp('TextEdit');

    await app.selectText(2, 'hi', { suffix: '!' });
    await app.paste('**bold**', { format: 'md' });

    expect(calls.filter((c) => c.tool === 'select_text' || c.tool === 'paste')).toEqual([
      { tool: 'select_text', args: { app: 'com.apple.TextEdit', element_index: 2, text: 'hi', prefix: '', suffix: '!', selection_type: 'text' } },
      { tool: 'paste', args: { app: 'com.apple.TextEdit', text: '**bold**', format: 'md' } },
    ]);
  });

  it("reports the runtime's refusal as the action's error", async () => {
    const calls: string[] = [];
    const { cua } = createCua({
      driver: codexDriver(async (tool) => {
        calls.push(tool);
        if (tool === 'list_apps') return { ok: true, data: { apps: [{ id: 'com.apple.Terminal', displayName: 'Terminal', isRunning: true }] } };
        if (tool === 'type_text') return { ok: false, error: { code: 'codex_error', message: "Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons." } };
        return { ok: true, data: { state: 'Window: "zsh", App: Terminal.' } };
      }, 'mac'),
      write: () => undefined,
      emitImage: () => undefined,
      showForegroundNotice: async () => undefined,
    });
    const app = await cua.getApp('Terminal');

    await expect(app.typeText('ls')).rejects.toThrow('not allowed to use the app');
  });
});
