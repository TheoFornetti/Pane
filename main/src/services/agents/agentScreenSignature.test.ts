import { describe, expect, it } from 'vitest';
import { detectAgentComposer, detectAgentFromScreen } from './agentScreenSignature';

const rule = '─'.repeat(40);

describe('detectAgentFromScreen', () => {
  it('recognises Claude by its closed composer box', () => {
    expect(detectAgentFromScreen(`✻ Done\n${rule}\n❯ \n${rule}\n  ? for shortcuts`)).toBe('claude');
    expect(detectAgentFromScreen(`${rule}\n❯ half-typed prompt\n${rule}`)).toBe('claude');
  });

  it('does not take a shell prompt or a Claude menu for the composer box', () => {
    expect(detectAgentFromScreen('~/repo on main\n❯ ')).toBeUndefined();
    expect(detectAgentFromScreen(`${rule}\n❯ `)).toBeUndefined();
    expect(detectAgentFromScreen(`${rule}\n Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder`)).toBeUndefined();
  });

  it('recognises Codex by its header and prompt', () => {
    const codex = '╭────────────╮\n│ >_ OpenAI Codex (v0.157.1) │\n╰────────────╯\n\n› Ask Codex to do anything\n';
    expect(detectAgentFromScreen(codex)).toBe('codex');
    expect(detectAgentFromScreen('› Ask Codex to do anything\n')).toBeUndefined();
    expect(detectAgentFromScreen('OpenAI Codex docs\n$ ')).toBeUndefined();
  });

  it('ignores empty screens', () => {
    expect(detectAgentFromScreen(undefined)).toBeUndefined();
    expect(detectAgentFromScreen('')).toBeUndefined();
  });
});

describe('detectAgentComposer', () => {
  it('reads held text in the Claude and Codex composers', () => {
    expect(detectAgentComposer(`${rule}\n❯ ship it\n${rule}`, 'claude')).toEqual({ isPresent: true, hasUndeliveredText: true });
    expect(detectAgentComposer(`${rule}\n❯ \n${rule}`, 'claude')).toEqual({ isPresent: true, hasUndeliveredText: false });
    expect(detectAgentComposer('› Ask Codex to do anything', 'codex')).toEqual({ isPresent: true, hasUndeliveredText: false });
    expect(detectAgentComposer('› run tests', 'codex')).toEqual({ isPresent: true, hasUndeliveredText: true });
    expect(detectAgentComposer('model:     loading\n› ', 'codex')).toEqual({ isPresent: false, hasUndeliveredText: false });
  });

  it('reports no composer for agents Pane cannot read', () => {
    expect(detectAgentComposer(`${rule}\n❯ ship it\n${rule}`, 'cursor')).toEqual({ isPresent: false, hasUndeliveredText: false });
    expect(detectAgentComposer(`${rule}\n❯ ship it\n${rule}`, undefined)).toEqual({ isPresent: false, hasUndeliveredText: false });
  });
});
