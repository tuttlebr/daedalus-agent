/**
 * Links built from model, tool, or provider data bypass the Markdown
 * sanitizer, so they must apply the same policy: only absolute http(s) URLs.
 * The original string is returned so displayed and opened URLs stay identical.
 */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
