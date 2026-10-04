import { describe, expect, it, vi } from 'vitest';

async function loadFresh() {
  vi.resetModules();
  return import('./deliveredSecrets');
}

describe('redactDeliveredSecrets', () => {
  it('leaves text unchanged when nothing has been delivered', async () => {
    const { redactDeliveredSecrets } = await loadFresh();

    expect(redactDeliveredSecrets('OPENAI_API_KEY=sk-canary-0001')).toBe('OPENAI_API_KEY=sk-canary-0001');
  });

  it('replaces every occurrence of a delivered value', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    registerDeliveredSecrets(['sk-canary-0001']);

    expect(redactDeliveredSecrets('env {"OPENAI_API_KEY":"sk-canary-0001"} again sk-canary-0001'))
      .toBe('env {"OPENAI_API_KEY":"[redacted]"} again [redacted]');
  });

  it('redacts the longer of two overlapping values whole', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    registerDeliveredSecrets(['canary-value', 'canary-value-extended']);

    expect(redactDeliveredSecrets('x canary-value-extended y')).toBe('x [redacted] y');
  });

  it('ignores values too short to be secrets', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    registerDeliveredSecrets(['true', '3000', '']);

    expect(redactDeliveredSecrets('PANE_PORT=3000 enabled=true')).toBe('PANE_PORT=3000 enabled=true');
  });
});
