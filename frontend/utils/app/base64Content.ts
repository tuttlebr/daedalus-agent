import { hasBoundedHtmlImages } from './embeddedHtmlImages';

/**
 * Remove inline base64 payloads from a conversation record before it is
 * stored, in the browser and on the server alike. Raw data URLs are blanked;
 * a data URL embedded in prose is replaced in place so the surrounding text
 * survives. Bounded assistant HTML documents keep their display images, and
 * model preparation separately omits inline image bytes.
 */
export function stripBase64Content(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripBase64Content(item));
  }

  const cleaned = { ...obj };

  const dataUrlRegex =
    /data:(image|video|application|text)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      if (
        key === 'content' &&
        obj.role === 'assistant' &&
        hasBoundedHtmlImages(value)
      ) {
        continue;
      }
      // Drop raw data URLs and strip embedded ones without nuking full content.
      if (
        value.startsWith('data:image/') ||
        value.startsWith('data:video/') ||
        value.startsWith('data:application/') ||
        value.startsWith('data:text/')
      ) {
        cleaned[key] = '';
        continue;
      }

      if (dataUrlRegex.test(value)) {
        cleaned[key] = value.replace(dataUrlRegex, '[base64 omitted]');
      }
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = stripBase64Content(value);
    }
  }

  return cleaned;
}
