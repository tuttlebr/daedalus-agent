/**
 * Error text a backend wrote for users, taken from a failed response body.
 *
 * The Rust runtime and the Python image API report failures as JSON whose
 * string `detail` (or `error`, or `error.message`) is written for the person
 * using the app: validation problems, ownership refusals and fixed messages
 * such as "Upstream image service error". Any other body (a proxy's HTML
 * page, a plain-text stack trace, a validation array) can name internal hosts
 * or implementation details, so callers log it and show a fixed message.
 */
const MAX_PUBLIC_DETAIL_CHARS = 500;

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > MAX_PUBLIC_DETAIL_CHARS
    ? `${text.slice(0, MAX_PUBLIC_DETAIL_CHARS - 1)}…`
    : text;
}

/** The user-facing detail in a JSON error body, or null when it has none. */
export function publicBackendDetail(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const error = record.error;
  return (
    boundedText(record.detail) ??
    boundedText(error) ??
    (error && typeof error === 'object' && !Array.isArray(error)
      ? boundedText((error as Record<string, unknown>).message)
      : null)
  );
}

/**
 * The detail a backend wrote for users, otherwise `fallback`. The raw body is
 * logged under `context` when it is not shown, so operators keep the cause.
 */
export function publicBackendErrorMessage(
  context: string,
  status: number,
  body: string,
  fallback: string,
): string {
  const detail = publicBackendDetail(body);
  if (detail) return detail;
  if (body.trim()) {
    console.warn(`${context}: backend error body withheld`, {
      status,
      body: body.slice(0, 2000),
    });
  }
  return fallback;
}
