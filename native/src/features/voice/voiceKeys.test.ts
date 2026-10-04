import { describe, expect, it } from 'vitest';

import { maskSecrets, voiceKeysFor } from './voiceKeys';

const none = { cleanup: false, recorded: false, streaming: false, fal: false, deepgram: false, openRouter: false };

describe('voiceKeysFor', () => {
  it('asks live mode for Deepgram and recorded mode for fal, with OpenRouter cleanup optional in both', () => {
    expect(voiceKeysFor('streaming', none)).toEqual([
      { key: 'deepgramApiKey', set: false, optional: false },
      { key: 'openRouterApiKey', set: false, optional: true },
    ]);
    expect(voiceKeysFor('recorded', { ...none, openRouter: true })).toEqual([
      { key: 'falApiKey', set: false, optional: false },
      { key: 'openRouterApiKey', set: true, optional: true },
    ]);
  });
});

describe('maskSecrets', () => {
  it('hides every typed key in an error message', () => {
    expect(maskSecrets('Deepgram rejected dg-abc123 (and dg-abc123)', ['dg-abc123', ''])).toBe('Deepgram rejected ••• (and •••)');
  });
});
