import { CODEX_LOADING_HEADER } from '../agentStatus/manifests';
import type { CliAgentType } from './agentIdentity';

/** What a terminal screen shows of an agent's input composer. */
export interface AgentComposerState {
  isPresent: boolean;
  hasUndeliveredText: boolean;
}

const NO_COMPOSER: AgentComposerState = { isPresent: false, hasUndeliveredText: false };
const CODEX_HEADER = /\bOpenAI Codex\b/u;

function screenLines(text: string): string[] {
  return text.split(/\r?\n/u).map(line => line.trim());
}

function isRule(line: string | undefined): boolean {
  return line !== undefined && /^─{3,}$/u.test(line);
}

interface ClaudeComposerBox {
  composer: AgentComposerState;
  closed: boolean;
}

// Claude draws its composer as a `❯` line boxed between two horizontal rules;
// held input is anything between the prompt marker and the closing rule.
function findClaudeComposerBox(lines: readonly string[]): ClaudeComposerBox | undefined {
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const match = lines[index].match(/^❯(?:\s+(.*))?$/u);
    if (!match || !isRule(lines[index - 1])) continue;

    const closingRule = lines.findIndex((line, lineIndex) => lineIndex > index && isRule(line));
    const held = [match[1] ?? '', ...lines.slice(index + 1, closingRule < 0 ? undefined : closingRule)];
    return {
      composer: { isPresent: true, hasUndeliveredText: held.some(line => line.length > 0) },
      closed: closingRule >= 0,
    };
  }
  return undefined;
}

function detectClaudeComposer(text: string): AgentComposerState {
  return findClaudeComposerBox(screenLines(text))?.composer ?? NO_COMPOSER;
}

function detectCodexComposer(text: string): AgentComposerState {
  if (CODEX_LOADING_HEADER.test(text)) return NO_COMPOSER;

  const lines = screenLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^[›❯]\s*(.*)$/u);
    if (!match) continue;

    const content = match[1].trim();
    const isPlaceholder = /^ask codex to do anything[.!]?$/iu.test(content);
    return {
      isPresent: true,
      hasUndeliveredText: content.length > 0 && !isPlaceholder,
    };
  }

  const hasPastedContent = /\[Pasted Content[^\]]*\]/iu.test(text);
  return {
    isPresent: hasPastedContent,
    hasUndeliveredText: hasPastedContent,
  };
}

/** The composer of a known agent; agents without composer detection report none. */
export function detectAgentComposer(text: string, agentType: CliAgentType | undefined): AgentComposerState {
  if (agentType === 'claude') return detectClaudeComposer(text);
  if (agentType === 'codex') return detectCodexComposer(text);
  return NO_COMPOSER;
}

/**
 * Identify an agent from one screen: Claude's closed rule/`❯`/rule composer
 * box, or Codex's `OpenAI Codex` header with its `›` prompt. Callers that
 * persist the result require it on consecutive polls, since one frame can
 * be anything.
 */
export function detectAgentFromScreen(text: string | undefined): CliAgentType | undefined {
  if (!text) return undefined;
  const lines = screenLines(text);
  if (findClaudeComposerBox(lines)?.closed) return 'claude';
  if (CODEX_HEADER.test(text) && lines.some(line => /^›(?:\s|$)/u.test(line))) return 'codex';
  return undefined;
}
