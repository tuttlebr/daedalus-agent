const HTML_FENCE_PATTERN = /^```(?:html|htm)\s*[\r\n]+([\s\S]*?)[\r\n]+```$/i;
const DOCUMENT_HTML_PATTERN =
  /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i;
const PAIRED_HTML_TAG_PATTERN = /^<([a-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/i;
const COMMON_HTML_TAG_PATTERN =
  /^<(?:article|aside|div|footer|header|main|nav|section|table|ul|ol|p|h[1-6]|style|script|svg|canvas)\b[\s\S]*>/i;
const VOID_HTML_TAG_PATTERN =
  /^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b[^>]*\/?>$/i;

export function extractStandaloneHtmlResponse(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(HTML_FENCE_PATTERN);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  return looksLikeStandaloneHtml(candidate) ? candidate : null;
}

export function looksLikeStandaloneHtml(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('<')) return false;

  return (
    DOCUMENT_HTML_PATTERN.test(trimmed) ||
    PAIRED_HTML_TAG_PATTERN.test(trimmed) ||
    COMMON_HTML_TAG_PATTERN.test(trimmed) ||
    VOID_HTML_TAG_PATTERN.test(trimmed)
  );
}
