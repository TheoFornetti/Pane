import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { VoiceTranscriptionMode } from '@shared/types/voiceTranscription';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { saveErrorMessage, useSaveHostSettings } from '../hosts/hostSettings';
import type { useVoiceDictation } from './useVoiceDictation';
import { maskSecrets, voiceKeysFor, type VoiceKey } from './voiceKeys';

/** Long enough for Deepgram to refuse a bad key before the sheet closes. */
const CONFIRM_MS = 2500;

const KEY_INFO: Record<VoiceKey, { name: string; role: string; url: string }> = {
  deepgramApiKey: { name: 'Deepgram', role: 'live transcription', url: 'https://console.deepgram.com' },
  openRouterApiKey: { name: 'OpenRouter', role: 'cleans up the text', url: 'https://openrouter.ai/keys' },
  falApiKey: { name: 'fal', role: 'recorded transcription', url: 'https://fal.ai/dashboard/keys' },
};

export interface VoiceSetupSheetProps {
  visible: boolean;
  onClose: () => void;
  voice: ReturnType<typeof useVoiceDictation>;
  /** Called once the keys are saved and recording has started. */
  onStarted: () => void;
}

/**
 * Opens from the mic when the host lacks a voice key. It asks only for the
 * keys the host doesn't have, saves them to the host, then starts recording
 * in the same tap. Keys the host has show as "Set", never their value; typed
 * keys leave the phone only in the save request and are cleared after it.
 */
export function VoiceSetupSheet({ visible, onClose, voice, onStarted }: VoiceSetupSheetProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const save = useSaveHostSettings();
  const [mode, setMode] = useState<VoiceTranscriptionMode>('streaming');
  const [typed, setTyped] = useState<Partial<Record<VoiceKey, string>>>({});
  const [replacing, setReplacing] = useState<VoiceKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const keys = voice.configured ? voiceKeysFor(mode, voice.configured) : [];
  const asked = keys.filter(item => !item.set || replacing.includes(item.key));
  const missing = keys.filter(item => !item.set).length;
  const ready = asked.every(item => typed[item.key]?.trim()) && asked.length > 0;
  const firstMissing = keys.find(item => !item.set);

  const reset = () => {
    setTyped({});
    setReplacing([]);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    const patch = Object.fromEntries(asked.map(item => [item.key, typed[item.key]?.trim() ?? '']));
    const secrets = Object.values(patch);
    setBusy(true);
    setError(null);
    try {
      await save.mutateAsync(patch);
      // Saved on the host; the phone keeps no copy.
      setTyped({});
      setReplacing([]);
      const failure = await voice.start(mode, CONFIRM_MS);
      if (failure) {
        voice.clearError();
        setError(/\b(401|403)\b/.test(failure) ? 'The key was refused. Replace it and try again.' : maskSecrets(failure, secrets));
        return;
      }
      reset();
      // Drop the request from the mutation's memory too.
      save.reset();
      onStarted();
    } catch (cause) {
      setError(maskSecrets(saveErrorMessage(cause, profile.label), secrets));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ComposerSheet visible={visible} onClose={close} testID="voice-setup-sheet">
      <View style={styles.content}>
        <View style={styles.header}>
          <Text variant="headline" accessibilityRole="header">Set up voice on {profile.label}</Text>
          <Text variant="subhead" tone="secondary">
            {missing === 0
              ? `Dictation runs on ${profile.label}. Replace a key, then recording starts.`
              : `Dictation runs on ${profile.label}. It needs ${missing === 1 ? 'one more key' : 'two more keys'}, then recording starts.`}
          </Text>
        </View>
        {keys.map(({ key, set }) => {
          const info = KEY_INFO[key];
          const asking = !set || replacing.includes(key);
          return (
            <View key={key} style={styles.field}>
              <Text variant="footnote" tone="secondary" style={styles.label}>{info.name} key · {info.role}</Text>
              {asking ? (
                <View style={[styles.input, { borderRadius: theme.radius.md, borderColor: typed[key] ? colors.accent : colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <TextInput
                    testID={`voice-key-${key}`}
                    accessibilityLabel={`${info.name} key`}
                    value={typed[key] ?? ''}
                    onChangeText={value => setTyped(current => ({ ...current, [key]: value }))}
                    placeholder={`Paste your ${info.name} key`}
                    placeholderTextColor={colors.textMuted}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    importantForAutofill="no"
                    keyboardAppearance={theme.scheme}
                    style={[theme.typography.subhead, styles.secret, { color: colors.text }]}
                  />
                  <Pressable
                    testID={`voice-key-paste-${key}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Paste ${info.name} key`}
                    hitSlop={8}
                    onPress={() => void Clipboard.getStringAsync().then(value => setTyped(current => ({ ...current, [key]: value.trim() })))}
                  >
                    <Text variant="callout" tone="accent" style={styles.bold}>Paste</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={[styles.input, { borderRadius: theme.radius.md, borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <Icon ios="checkmark" android="check" size={14} color={colors.success} />
                  <Text variant="subhead" style={[styles.secret, styles.bold, { color: colors.success }]} testID={`voice-key-set-${key}`}>Set</Text>
                  <Pressable
                    testID={`voice-key-replace-${key}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Replace ${info.name} key`}
                    hitSlop={8}
                    onPress={() => setReplacing(current => [...current, key])}
                  >
                    <Text variant="callout" tone="secondary">Replace</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
        <Text variant="footnote" tone="muted">
          Sent once over this phone's connection and stored on {profile.label}. Pane never shows a saved key again.
          {firstMissing ? (
            <Text variant="footnote" tone="accent" onPress={() => void Linking.openURL(KEY_INFO[firstMissing.key].url)}>
              {` Get a ${KEY_INFO[firstMissing.key].name} key`}
            </Text>
          ) : null}
        </Text>
        {error ? (
          <Text variant="footnote" tone="danger" testID="voice-setup-error" accessibilityLiveRegion="polite">{error}</Text>
        ) : null}
        <Button
          testID="voice-setup-save"
          title="Save and start recording"
          icon={<Icon ios="mic.fill" android="mic" size={15} color={colors.onAccent} />}
          disabled={!ready}
          loading={busy}
          onPress={() => void submit()}
        />
        <Pressable
          testID="voice-setup-mode"
          accessibilityRole="button"
          onPress={() => {
            reset();
            setMode(mode === 'streaming' ? 'recorded' : 'streaming');
          }}
          style={styles.switchMode}
        >
          <Text variant="callout" tone="accent" style={styles.bold}>
            {mode === 'streaming' ? 'Use recorded mode (fal) instead' : 'Use live mode (Deepgram) instead'}
          </Text>
        </Pressable>
      </View>
    </ComposerSheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 14 },
  header: { gap: 4 },
  field: { gap: 6 },
  label: { fontWeight: '600' },
  input: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderWidth: 1 },
  secret: { flex: 1, paddingVertical: 0 },
  bold: { fontWeight: '600' },
  switchMode: { alignItems: 'center', paddingVertical: 4 },
});
