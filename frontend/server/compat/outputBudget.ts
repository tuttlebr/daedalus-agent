/**
 * Final-answer output budget.
 *
 * Daedalus may route one run across providers with different tokenizers, and
 * the final answer is produced after internal tool rounds that have their own
 * bounded budgets (iteration limit and run deadline). The caller's limit
 * therefore applies to the returned answer only, measured with one documented
 * estimator: one token per four UTF-8 bytes, rounded up. Truncation happens at
 * a code point boundary and is reported as the protocol's length stop reason.
 */
export const BYTES_PER_ESTIMATED_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_ESTIMATED_TOKEN);
}

export interface BudgetedAnswer {
  text: string;
  truncated: boolean;
}

export function applyOutputBudget(
  text: string,
  maxTokens: number | null,
): BudgetedAnswer {
  if (maxTokens === null || estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }
  const maxBytes = maxTokens * BYTES_PER_ESTIMATED_TOKEN;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true };
}
