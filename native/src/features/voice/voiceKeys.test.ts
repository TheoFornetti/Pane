import { describe, expect, it } from 'vitest';

import { maskSecrets, voiceKeysFor } from './voiceKeys';

const none = { cleanup: false, recorded: false, streaming: false, fal: false, deepgram: false, openRouter: false };

describe('voiceKeysFor', () => {
  it('asks live mode for Deepgram and OpenRouter, recorded mode for fal and OpenRouter', () => {
    expect(voiceKeysFor('streaming', none)).toEqual([
      { key: 'deepgramApiKey', set: false },
      { key: 'openRouterApiKey', set: false },
    ]);
    expect(voiceKeysFor('recorded', { ...none, openRouter: true })).toEqual([
      { key: 'falApiKey', set: false },
      { key: 'openRouterApiKey', set: true },
    ]);
  });
});

describe('maskSecrets', () => {
  it('hides every typed key in an error message', () => {
    expect(maskSecrets('Deepgram rejected dg-abc123 (and dg-abc123)', ['dg-abc123', ''])).toBe('Deepgram rejected ••• (and •••)');
  });
});
