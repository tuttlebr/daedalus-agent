/**
 * Defang an untrusted string before embedding it into a natural-language
 * instruction sent to the tool-calling agent.
 *
 * This is a mitigation, not a guarantee — the robust fix is to pass untrusted
 * values as structured tool arguments rather than prose (F-008). It strips
 * newlines/control characters (so the value cannot introduce a new
 * "instruction" line), removes quote/bracket/markup characters an attacker
 * could use to break out of a surrounding quoted/tagged context, collapses
 * whitespace, and caps length.
 */
export function sanitizeForPromptInterpolation(
  value: unknown,
  maxLength = 256,
): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`"'<>{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
