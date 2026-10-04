import type { UsageTotals } from '../../../../shared/types/usage';
import { formatTokens } from '../ui/charts/chartScales';

type MessageCounts = Pick<UsageTotals, 'messageCount' | 'unmeteredMessageCount'>;

/** A slice with messages, none of which recorded tokens (Cursor). Its token figures are absent, not zero. */
export function tokensUnreported(totals: MessageCounts): boolean {
  return totals.unmeteredMessageCount > 0 && totals.unmeteredMessageCount === totals.messageCount;
}

export function unreportedLabel(messageCount: number): string {
  return `${messageCount.toLocaleString()} messages · tokens not reported`;
}

/** A token figure for the slice, or "Not reported" when its messages recorded none. */
export function formatSliceTokens(totals: MessageCounts, tokens: number): string {
  return tokensUnreported(totals) ? 'Not reported' : formatTokens(tokens);
}

export const UNREPORTED_COST_TITLE = 'Cursor records messages but not their tokens, so there is no cost to estimate.';

export const UNREPORTED_CHART_TEXT = 'Cursor records messages but not their tokens, so there are no tokens to chart.';
