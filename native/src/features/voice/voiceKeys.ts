import type { RemotePwaVoiceTranscriptionAffordance, RemoteSettingsPatch } from '@shared/types/remoteDaemon';
import type { VoiceTranscriptionMode } from '@shared/types/voiceTranscription';

export type VoiceKey = Exclude<keyof RemoteSettingsPatch, 'terminalShortcuts'>;

/** Live streams to Deepgram, recorded sends a clip to fal; OpenRouter cleans up the text either way. */
const MODE_KEYS: Record<VoiceTranscriptionMode, VoiceKey[]> = {
  streaming: ['deepgramApiKey', 'openRouterApiKey'],
  recorded: ['falApiKey', 'openRouterApiKey'],
};

const CONFIGURED: Record<VoiceKey, keyof RemotePwaVoiceTranscriptionAffordance['configured']> = {
  deepgramApiKey: 'deepgram',
  openRouterApiKey: 'openRouter',
  falApiKey: 'fal',
};

/** Each key `mode` needs, and whether the host already has it. */
export function voiceKeysFor(mode: VoiceTranscriptionMode, configured: RemotePwaVoiceTranscriptionAffordance['configured']) {
  return MODE_KEYS[mode].map(key => ({ key, set: configured[CONFIGURED[key]] }));
}

/** `message` with any of `secrets` masked, so an error can never show a key that was typed. */
export function maskSecrets(message: string, secrets: readonly string[]): string {
  return secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('•••'), message);
}
