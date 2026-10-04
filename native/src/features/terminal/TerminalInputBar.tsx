import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { useVoiceDictation } from '../voice/useVoiceDictation';

type Voice = ReturnType<typeof useVoiceDictation>;

export interface TerminalInputBarProps {
  draft: string;
  onChangeDraft: (text: string) => void;
  /** Sends the draft followed by Enter, or a bare Enter when the draft is empty. */
  onSubmit: () => void;
  voice: Voice;
  /** Opens Photos, Camera and Files. */
  onAttach: () => void;
  /** Pastes the phone clipboard at the cursor. */
  onPaste: () => void;
  onShortcuts: () => void;
  /** Opens the terminal's recent output as selectable text. */
  onCopy: () => void;
  /** The mic, when the host lacks a voice key: asks for it, then records. */
  onSetupVoice: () => void;
  /** Where the cursor is, so inserts land there. */
  onSelectionChange: (selection: { start: number; end: number }) => void;
  /** Moves the cursor after an insert; undefined leaves it to the user. */
  selection?: { start: number; end: number };
  disabled?: boolean;
}

/**
 * One box holds every composer action: the draft on top, then Attach, Paste,
 * Shortcuts and Copy on the left and the mic and Send/Enter on the right.
 * Return adds a line; the button sends. While dictating, the words heard so
 * far show in the box, dimmed and read-only.
 */
export function TerminalInputBar({
  draft, onChangeDraft, onSubmit, voice, onAttach, onPaste, onShortcuts, onCopy, onSetupVoice, onSelectionChange, selection, disabled = false,
}: TerminalInputBarProps) {
  const theme = useTheme();
  const { colors } = theme;
  const voiceBusy = voice.phase !== 'idle';
  const previewing = voiceBusy && voice.preview.length > 0;
  const shown = previewing ? (draft.trim() ? `${draft}${/\s$/.test(draft) ? '' : ' '}${voice.preview}` : voice.preview) : draft;

  return (
    <View style={[styles.box, { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: colors.background }]}>
      <TextInput
        testID="terminal-input"
        value={shown}
        onChangeText={text => !previewing && onChangeDraft(text)}
        onSelectionChange={event => onSelectionChange(event.nativeEvent.selection)}
        selection={previewing ? undefined : selection}
        editable={!disabled && !previewing}
        placeholder="Type, dictate or pick a shortcut"
        placeholderTextColor={colors.textMuted}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        smartInsertDelete={false}
        keyboardAppearance={theme.scheme}
        textAlignVertical="top"
        selectionColor={colors.accent}
        style={[styles.input, { color: previewing ? colors.textMuted : colors.text, opacity: disabled ? 0.5 : 1 }]}
      />
      <View style={styles.actions}>
        <BoxAction testID="terminal-attach" label="Attach files" hint="Copies photos or files to the host and inserts their paths" ios="paperclip" android="attach_file" disabled={disabled} onPress={onAttach} />
        <BoxAction testID="terminal-paste" label="Paste" hint="Pastes the clipboard at the cursor" ios="doc.on.clipboard" android="content_paste" tinted disabled={disabled} onPress={onPaste} />
        <BoxAction testID="terminal-shortcuts" label="Shortcuts" hint="Inserts one of the host's shortcuts" ios="bolt" android="bolt" disabled={disabled} onPress={onShortcuts} />
        <BoxAction testID="terminal-copy" label="Copy from terminal" hint="Shows recent output to copy" ios="doc.on.doc" android="content_copy" disabled={disabled} onPress={onCopy} />
        <View style={styles.spacer} />
        <MicButton voice={voice} disabled={disabled} onSetup={onSetupVoice} />
        <SendButton hasText={draft.trim().length > 0} dimmed={disabled || voiceBusy} onPress={onSubmit} />
      </View>
    </View>
  );
}

function BoxAction({ testID, label, hint, ios, android, tinted = false, disabled, onPress }: {
  testID: string;
  label: string;
  hint: string;
  ios: SFSymbol;
  android: AndroidSymbol;
  /** The most-used action, drawn tinted. */
  tinted?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.action,
        {
          borderRadius: theme.radius.md,
          backgroundColor: pressed ? colors.surfacePressed : tinted ? colors.selected : 'transparent',
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Icon ios={ios} android={android} size={17} color={tinted ? colors.accentText : colors.textSecondary} />
    </Pressable>
  );
}

/**
 * Empty box: outlined "Enter" that sends a bare Enter, to answer a menu or
 * confirm a prompt. With text: filled "Send" that sends it, then Enter. One
 * footprint in every state, so nothing beside it moves.
 */
function SendButton({ hasText, dimmed, onPress }: { hasText: boolean; dimmed: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const send = hasText || dimmed;
  const tint = send ? colors.onAccent : colors.text;
  return (
    <Pressable
      testID="terminal-send"
      accessibilityRole="button"
      accessibilityLabel={hasText ? 'Send' : 'Enter'}
      accessibilityHint={hasText ? 'Sends the text, then Enter' : 'Sends Enter'}
      accessibilityState={{ disabled: dimmed }}
      disabled={dimmed}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.send,
        {
          borderRadius: theme.radius.md,
          borderColor: send ? colors.accent : colors.border,
          backgroundColor: send ? colors.accent : pressed ? colors.surfacePressed : colors.surfaceRaised,
          opacity: dimmed ? 0.5 : pressed && send ? 0.8 : 1,
        },
      ]}
    >
      <Icon ios={send ? 'paperplane.fill' : 'return.left'} android={send ? 'send' : 'keyboard_return'} size={14} color={tint} />
      <Text variant="callout" style={[styles.sendLabel, { color: tint }]}>{send ? 'Send' : 'Enter'}</Text>
    </Pressable>
  );
}

/** The mic; while recording, a red stop key with the elapsed time beside it. */
function MicButton({ voice, disabled, onSetup }: { voice: Voice; disabled: boolean; onSetup: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const listening = voice.phase === 'listening';
  const busy = voice.phase === 'starting' || voice.phase === 'transcribing';
  const off = !listening && (disabled || busy || !voice.loaded);

  return (
    <View style={styles.micRow}>
      {listening ? <RecordingTime /> : null}
      <Pressable
        testID="terminal-mic"
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Stop voice recording' : 'Start voice recording'}
        accessibilityHint={voice.available || listening ? undefined : 'Sets up voice on the host first'}
        accessibilityState={{ busy, disabled: off }}
        disabled={off}
        hitSlop={4}
        onPress={() => {
          void Haptics.impactAsync(listening ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium);
          if (voice.available || listening) voice.toggle();
          else onSetup();
        }}
        style={({ pressed }) => [
          styles.action,
          {
            borderRadius: theme.radius.md,
            backgroundColor: listening ? colors.danger : pressed ? colors.surfacePressed : 'transparent',
            opacity: off && !busy ? 0.5 : 1,
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Icon
            ios={listening ? 'stop.fill' : 'mic'}
            android={listening ? 'stop' : 'mic'}
            size={listening ? 14 : 18}
            color={listening ? colors.onAccent : colors.textSecondary}
          />
        )}
      </Pressable>
    </View>
  );
}

/** Seconds since recording started, counted from when it appears. */
function RecordingTime() {
  const { colors } = useTheme();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={styles.timer} accessibilityLabel={`Recording, ${seconds} seconds`}>
      <Icon ios="waveform" android="graphic_eq" size={15} color={colors.danger} />
      <Text variant="footnote" tone="danger" style={styles.timerText}>
        {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
      </Text>
    </View>
  );
}

const ACTION = 32;

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  input: {
    minHeight: 38,
    maxHeight: 160,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    fontSize: 14,
    lineHeight: 19,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 5, paddingBottom: 5 },
  spacer: { flex: 1 },
  action: { width: ACTION, height: ACTION, alignItems: 'center', justifyContent: 'center' },
  micRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 4 },
  timer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timerText: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  send: {
    width: 78,
    height: ACTION,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  sendLabel: { fontSize: 13, fontWeight: '600' },
});
