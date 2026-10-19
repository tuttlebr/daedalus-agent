import { getRedis } from '@/server/session/redis';
import { ownsUpload, type UploadViewer } from '@/server/uploadOwnership';

export const GENERATED_IMAGE_ID_PATTERN = /^[a-f0-9-]+$/i;

export function generatedImageKey(imageId: string): string {
  return `generated:image:${imageId}`;
}

/**
 * Generated images are stored by the backend as one RedisJSON document holding
 * the multi-megabyte base64 original. Ownership checks and thumbnail views need
 * only a few small fields plus whether the original exists, so RedisJSON
 * records return those fields and the payload length. Legacy plain-string
 * records are still read whole. Missing keys return nil.
 */
const READ_GENERATED_IMAGE_FIELDS_LUA = `
local reply = redis.call('TYPE', KEYS[1])
local kind = type(reply) == 'table' and reply['ok'] or reply
if kind == 'none' then return false end
if kind == 'string' then return {'string', redis.call('GET', KEYS[1])} end
if not string.find(string.lower(kind), 'rejson', 1, true) then return false end
local fields = redis.call('JSON.GET', KEYS[1], '$.userId', '$.user', '$.sessionId', unpack(ARGV))
local length = redis.call('JSON.STRLEN', KEYS[1], '$.data')[1]
return {'json', fields, length or 0}
`;

// Concurrent first views may both encode a thumbnail; NX keeps the first and
// never touches a record that was deleted or replaced by a legacy string.
const PERSIST_GENERATED_THUMBNAIL_LUA = `
local reply = redis.call('TYPE', KEYS[1])
local kind = type(reply) == 'table' and reply['ok'] or reply
if not string.find(string.lower(kind), 'rejson', 1, true) then return false end
return redis.call('JSON.SET', KEYS[1], '$.thumbnail', ARGV[1], 'NX')
`;

export type GeneratedImageField = 'mimeType' | 'thumbnail';

export interface GeneratedImageRecord {
  storage: 'json' | 'string';
  hasData: boolean;
  // Owner fields stay as stored so a malformed owner can never match.
  userId?: unknown;
  user?: unknown;
  sessionId?: unknown;
  mimeType?: string;
  /** Base64 JPEG thumbnail persisted on the first thumbnail view. */
  thumbnail?: string;
  /** Only legacy plain-string records, which are always read whole. */
  data?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function firstPathValue(fields: Record<string, unknown>, field: string) {
  const values = fields[`$.${field}`];
  return Array.isArray(values) ? values[0] : undefined;
}

/** Read owner fields (and any requested view fields) without `$.data`. */
export async function readGeneratedImageRecord(
  imageId: string,
  fields: readonly GeneratedImageField[] = [],
): Promise<GeneratedImageRecord | null> {
  const reply = (await getRedis().eval(
    READ_GENERATED_IMAGE_FIELDS_LUA,
    1,
    generatedImageKey(imageId),
    ...fields.map((field) => `$.${field}`),
  )) as [string, string | null, number?] | null;
  if (!reply) return null;
  const [kind, payload, dataLength] = reply;
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const value =
    kind === 'string'
      ? (field: string) => parsed[field]
      : (field: string) => firstPathValue(parsed, field);
  const data = kind === 'string' ? optionalString(parsed.data) : undefined;
  return {
    storage: kind === 'string' ? 'string' : 'json',
    hasData: kind === 'string' ? Boolean(data) : Number(dataLength) > 0,
    userId: value('userId'),
    user: value('user'),
    sessionId: value('sessionId'),
    mimeType: optionalString(value('mimeType')),
    thumbnail: optionalString(value('thumbnail')),
    ...(data ? { data } : {}),
  };
}

/** Read every candidate in one concurrent batch. */
export async function readGeneratedImageRecords(
  imageIds: string[],
): Promise<(GeneratedImageRecord | null)[]> {
  return Promise.all(
    imageIds.map((imageId) => readGeneratedImageRecord(imageId)),
  );
}

/** The base64 original; legacy string records already carry it. */
export async function readGeneratedImageData(
  imageId: string,
  record: GeneratedImageRecord,
): Promise<string | null> {
  if (record.storage === 'string') return record.data ?? null;
  const reply = (await getRedis().call(
    'JSON.GET',
    generatedImageKey(imageId),
    '$.data',
  )) as string | null;
  if (!reply) return null;
  const values = JSON.parse(reply);
  return Array.isArray(values) ? optionalString(values[0]) ?? null : null;
}

export async function persistGeneratedImageThumbnail(
  imageId: string,
  thumbnail: string,
): Promise<void> {
  await getRedis().eval(
    PERSIST_GENERATED_THUMBNAIL_LUA,
    1,
    generatedImageKey(imageId),
    JSON.stringify(thumbnail),
  );
}

/** Generated records name their owner as `userId` or the legacy `user`. */
export function ownsGeneratedImage(
  record: Pick<GeneratedImageRecord, 'userId' | 'user' | 'sessionId'>,
  viewer: UploadViewer,
): boolean {
  return ownsUpload(
    { userId: record.userId || record.user, sessionId: record.sessionId },
    viewer,
  );
}
