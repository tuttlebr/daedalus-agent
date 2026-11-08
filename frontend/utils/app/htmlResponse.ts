const HTML_FENCE_PATTERN = /^```(?:html|htm)\s*[\r\n]+([\s\S]*?)[\r\n]+```$/i;
const DOCUMENT_HTML_PATTERN =
  /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i;
const DOCUMENT_DOCTYPE_PATTERN = /<!doctype\s+html\b/i;
const DOCUMENT_END_PATTERN = /<\/html\s*>/i;
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

  if (looksLikeStandaloneHtml(candidate)) return candidate;

  // The response contract for renderable artifacts requires HTML-only output,
  // but models can occasionally leak a short progress sentence before the
  // document. Recover the complete document so one accidental preamble does
  // not turn the entire artifact into raw Markdown. Keep this deliberately
  // narrower than the standalone-snippet detector: embedded fragments remain
  // ordinary prose and only a full doctype-to-</html> document is recovered.
  const documentStart = trimmed.search(DOCUMENT_DOCTYPE_PATTERN);
  if (documentStart < 0) return null;

  const documentTail = trimmed.slice(documentStart);
  const documentEnd = documentTail.match(DOCUMENT_END_PATTERN);
  if (!documentEnd || documentEnd.index === undefined) return null;

  const recovered = documentTail
    .slice(0, documentEnd.index + documentEnd[0].length)
    .trim();

  return looksLikeStandaloneHtml(recovered) ? recovered : null;
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
