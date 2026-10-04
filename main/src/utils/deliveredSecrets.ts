/**
 * Values Pane has delivered into an agent's environment (Pane Vault). Every
 * log sink Pane writes passes its text through `redactDeliveredSecrets`, so a
 * delivered value never reaches Pane's own logs, whatever path logged it.
 *
 * What the agent itself prints to its terminal is outside this guarantee.
 */

// Shorter values (ports, flags) are not secrets and would redact common text.
const MIN_SECRET_LENGTH = 8;
const REDACTED = '[redacted]';

// Longest first, so a value that contains another is replaced whole.
let deliveredValues: string[] = [];

export function registerDeliveredSecrets(values: Iterable<string>): void {
  const merged = new Set(deliveredValues);
  for (const value of values) {
    if (value.length >= MIN_SECRET_LENGTH) merged.add(value);
  }
  deliveredValues = [...merged].sort((a, b) => b.length - a.length);
}

export function redactDeliveredSecrets(text: string): string {
  let redacted = text;
  for (const value of deliveredValues) {
    if (redacted.includes(value)) redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}
