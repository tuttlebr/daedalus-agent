import type { IncomingHttpHeaders } from 'node:http';

const HOST_PATTERN =
  /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

function firstHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw || '').split(',')[0].trim();
}

/**
 * The browser origin of this Daedalus deployment, for links in API responses.
 * `DAEDALUS_PUBLIC_URL` wins; otherwise the proxy's forwarded host is used.
 * Links point at session-authenticated application pages and routes, so they
 * grant nothing to a holder who is not signed in as the same user.
 */
export function publicOrigin(
  headers: IncomingHttpHeaders,
  socketEncrypted = false,
): string | null {
  const configured = process.env.DAEDALUS_PUBLIC_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.protocol === 'http:')
        return url.origin;
    } catch {
      // Fall through to the request's own origin.
    }
  }
  const host =
    firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
  if (!host || !HOST_PATTERN.test(host)) return null;
  const forwarded = firstHeader(headers['x-forwarded-proto']);
  const proto =
    forwarded === 'http' || forwarded === 'https'
      ? forwarded
      : socketEncrypted
      ? 'https'
      : 'http';
  return `${proto}://${host}`;
}

/** A Daedalus page link, or a path when the origin is unknown. */
export function appLink(origin: string | null, pathAndQuery: string): string {
  return origin ? `${origin}${pathAndQuery}` : pathAndQuery;
}

/**
 * Answers reference generated images and artifacts with app-relative
 * Markdown targets (`](/api/...)`). API clients have no page to resolve them
 * against, so give them this deployment's origin.
 */
export function absolutizeAppLinks(
  text: string,
  origin: string | null,
): string {
  if (!origin) return text;
  return text.replace(/\]\((\/(?!\/)[^)\s]*)/g, (_, path: string) => {
    return `](${origin}${path}`;
  });
}
