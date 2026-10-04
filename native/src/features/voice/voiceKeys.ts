import type { RemotePwaVoiceTranscriptionAffordance, RemoteSettingsPatch } from '@shared/types/remoteDaemon';
import type { VoiceTranscriptionMode } from '@shared/types/voiceTranscription';

export type VoiceKey = Exclude<keyof RemoteSettingsPatch, 'terminalShortcuts'>;

/** Live streams to Deepgram, recorded sends a clip to fal. OpenRouter only cleans up the text, in either mode. */
const REQUIRED_KEY: Record<VoiceTranscriptionMode, VoiceKey> = {
  streaming: 'deepgramApiKey',
  recorded: 'falApiKey',
};

const CONFIGURED: Record<VoiceKey, keyof RemotePwaVoiceTranscriptionAffordance['configured']> = {
  deepgramApiKey: 'deepgram',
  openRouterApiKey: 'openRouter',
  falApiKey: 'fal',
};

/** The key `mode` needs, then the optional cleanup key, each with whether the host already has it. */
export function voiceKeysFor(mode: VoiceTranscriptionMode, configured: RemotePwaVoiceTranscriptionAffordance['configured']) {
  return ([REQUIRED_KEY[mode], 'openRouterApiKey'] as const).map(key => ({
    key,
    set: configured[CONFIGURED[key]],
    optional: key === 'openRouterApiKey',
  }));
}

/** `message` with any of `secrets` masked, so an error can never show a key that was typed. */
export function maskSecrets(message: string, secrets: readonly string[]): string {
  return secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('•••'), message);
}
