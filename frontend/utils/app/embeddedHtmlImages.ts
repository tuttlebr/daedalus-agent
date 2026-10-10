import { extractStandaloneHtmlResponse } from './htmlResponse';

// The briefing renderer embeds at most six raster photos of 74 KB each.
// Preserve those display artifacts when saving a conversation; attachments
// still use the separate image store and model context never needs these bytes.
const MAX_HTML_CHARS = 2_000_000;
const MAX_IMAGE_URL_CHARS = 100_000;
const DATA_URL_PATTERN =
  /data:(?:image|video|application|text)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const RASTER_URL_PATTERN =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;

export function hasBoundedHtmlImages(content: string): boolean {
  if (content.length > MAX_HTML_CHARS) return false;
  const html = extractStandaloneHtmlResponse(content);
  if (!html) return false;
  const images = html.match(DATA_URL_PATTERN) ?? [];
  return (
    images.length > 0 &&
    images.length <= 6 &&
    images.every(
      (url) =>
        url.length <= MAX_IMAGE_URL_CHARS && RASTER_URL_PATTERN.test(url),
    )
  );
}

export function omitInlineDataForModel(content: string): string {
  return content.replace(DATA_URL_PATTERN, '[base64 omitted]');
}
