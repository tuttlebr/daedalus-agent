export const DEFAULT_TIMEZONE = 'America/New_York';
export const TIMEZONE_HEADER_NAME = 'x-timezone';

type HeaderMap = Record<string, string | string[] | number | undefined>;

const TIMEZONE_HEADER_ALIASES = new Set([
  TIMEZONE_HEADER_NAME,
  'timezone',
  'time-zone',
]);

function firstHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0].trim() : '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeTimezone(timezone: unknown): string {
  const candidate = firstHeaderValue(timezone) || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function resolveTimezoneFromHeaders(headers: HeaderMap = {}): string {
  for (const [name, value] of Object.entries(headers)) {
    if (TIMEZONE_HEADER_ALIASES.has(name.toLowerCase())) {
      return normalizeTimezone(value);
    }
  }
  return DEFAULT_TIMEZONE;
}

export function stripTimezoneHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!TIMEZONE_HEADER_ALIASES.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}

export function withTimezoneHeader(
  headers: Record<string, string>,
  timezone?: unknown,
): Record<string, string> {
  return {
    ...stripTimezoneHeaders(headers),
    [TIMEZONE_HEADER_NAME]: normalizeTimezone(timezone),
  };
}

export function withInternalBackendAuth(
  headers: Record<string, string>,
): Record<string, string> {
  const token = process.env.DAEDALUS_INTERNAL_API_TOKEN?.trim();
  if (!token) {
    return headers;
  }

  return {
    ...headers,
    'x-daedalus-internal-token': token,
  };
}
