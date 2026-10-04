import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

type Shortcut = RemotePwaTerminalShortcut;

/** Enabled shortcuts whose name or text contains every word of `query`, in list order. */
export function filterShortcuts(shortcuts: readonly Shortcut[], query: string): Shortcut[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return shortcuts.filter(shortcut => {
    if (!shortcut.enabled || !shortcut.text.trim()) return false;
    const haystack = `${shortcut.label}\n${shortcut.text}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export interface ShortcutProblems {
  label?: string;
  text?: string;
  key?: string;
}

/**
 * What stops `draft` from saving into `list`, by field. Desktop binds each
 * enabled shortcut to ⌘⌥ (Ctrl+Alt) plus one letter, so the letter must be
 * a to z and no other enabled shortcut may use it.
 */
export function shortcutProblems(draft: Shortcut, list: readonly Shortcut[]): ShortcutProblems {
  const problems: ShortcutProblems = {};
  if (!draft.label.trim()) problems.label = 'Add a name';
  if (!draft.text.trim()) problems.text = 'Add the text to insert';
  if (!/^[a-z]$/.test(draft.key)) problems.key = 'Pick a letter from A to Z';
  else if (draft.enabled && list.some(other => other.id !== draft.id && other.enabled && other.key === draft.key)) {
    problems.key = `${draft.key.toUpperCase()} is taken by another shortcut`;
  }
  return problems;
}

/** The first letter no enabled shortcut uses, for a new one. */
export function freeLetter(list: readonly Shortcut[]): string {
  const taken = new Set(list.filter(shortcut => shortcut.enabled).map(shortcut => shortcut.key));
  return 'abcdefghijklmnopqrstuvwxyz'.split('').find(letter => !taken.has(letter)) ?? '';
}
