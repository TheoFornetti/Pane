import { format } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const savedConsole = { ...console };

function throwingConsoleMethod(error: Error): typeof console.log {
  return vi.fn(() => {
    throw error;
  });
}

async function loadConsoleWrapperWithOriginals(originals: Partial<Console>) {
  vi.resetModules();
  Object.assign(console, originals);
  return import('./consoleWrapper');
}

afterEach(() => {
  Object.assign(console, savedConsole);
  vi.resetModules();
});

describe('setupConsoleWrapper', () => {
  it('ignores EPIPE from closed stdout or stderr streams', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const { setupConsoleWrapper } = await loadConsoleWrapperWithOriginals({
      log: throwingConsoleMethod(epipe),
      error: throwingConsoleMethod(epipe),
    });

    setupConsoleWrapper();

    expect(() => console.log('[Main] startup log')).not.toThrow();
    expect(() => console.error('[Pane daemon] Failed to start local daemon server')).not.toThrow();
  });

  it('preserves unexpected console write failures', async () => {
    const { setupConsoleWrapper } = await loadConsoleWrapperWithOriginals({
      log: throwingConsoleMethod(new Error('unexpected console failure')),
    });

    setupConsoleWrapper();

    expect(() => console.log('[Main] startup log')).toThrow('unexpected console failure');
  });

  it('never prints a delivered value', async () => {
    const canary = 'sk-pane-vault-canary-7f3a91';
    const printed: string[] = [];
    const capture = vi.fn((...args: string[]) => {
      printed.push(format(...args));
    });
    const { setupConsoleWrapper } = await loadConsoleWrapperWithOriginals({ error: capture, warn: capture });
    const { registerDeliveredSecrets } = await import('./deliveredSecrets');
    registerDeliveredSecrets([canary]);

    setupConsoleWrapper();
    console.error('[ptyHost] received unknown frame, dropping', { env: { OPENAI_API_KEY: canary } });
    console.warn(`[Pane daemon] OPENAI_API_KEY=${canary}`);

    expect(printed).toHaveLength(2);
    expect(printed.join('\n')).not.toContain(canary);
  });
});
