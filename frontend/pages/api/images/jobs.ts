import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';
import {
  cleanImageParamsForModel,
  removeImageParamKeys,
  resolveImageModel,
  validateImageParamsForSubmit,
  type ImageMode,
  type ImageParams,
} from '@/utils/app/imageModelCapabilities';
import {
  resolveTimezoneFromHeaders,
  withInternalBackendAuth,
  withTimezoneHeader,
} from '@/utils/server/backendAuth';

import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import { jsonGet, jsonSetWithExpiry, sessionKey } from '@/server/session/redis';
import { randomUUID } from 'crypto';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
    responseLimit: false,
  },
  // Leave room to persist the final OpenAI response after the backend's 300s
  // provider timeout; nginx permits this route for 360s.
  maxDuration: 360,
};

const IMAGE_JOB_TTL_SECONDS = 60 * 60;
const IMAGE_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_HISTORY_ENTRIES = 50;
const MAX_USER_JOBS = 20;
const MAX_ACTIVE_JOBS_PER_USER = 2;
const IMAGE_TIMEOUT_MS = 330_000;
const STREAM_PARTIAL_IMAGES = 2;
const IMAGE_JOB_RATE_LIMIT = ruleFromEnv(
  'image-job',
  'RATE_LIMIT_IMAGE_JOB',
  5,
  60,
);
const UNSAFE_BROWSER_KEYS = [
  'apiKey',
  'openaiApiKey',
  'openai_api_key',
  'OPENAI_API_KEY',
  'authorization',
  'Authorization',
];

type ImageJobState = {
  jobId: string;
  userId: string;
  sessionId: string;
  mode: ImageMode;
  status: 'queued' | 'running' | 'completed' | 'error';
  prompt: string;
  model: string;
  params: ImageParams;
  inputImages: unknown[];
  maskImage: unknown | null;
  partialImageIds: string[];
  outputImageIds: string[];
  usage?: Record<string, unknown>;
  error?: string;
  historyEntry?: ImageHistoryEntry;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

type ImageHistoryEntry = {
  id: string;
  mode: ImageMode;
  prompt: string;
  params: ImageParams;
  inputImages: unknown[];
  maskImage: unknown | null;
  outputImageIds: string[];
  model: string;
  createdAt: number;
  usage?: Record<string, unknown>;
};

type ImageGenerationResponse = {
  imageIds: string[];
  model?: string;
  prompt?: string;
  usage?: Record<string, unknown>;
};

class ImageBackendError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jobKey(jobId: string): string {
  return sessionKey(['image-job', jobId]);
}

function userJobsKey(userId: string): string {
  return sessionKey(['user', userId, 'imageJobs']);
}

function historyKey(userId: string, sessionId: string): string {
  if (userId && userId !== 'anon') {
    return sessionKey(['user', userId, 'imagePanelHistory']);
  }
  return sessionKey(['session', sessionId, 'imagePanelHistory']);
}

function publicJobState(status: ImageJobState): Omit<ImageJobState, 'userId'> {
  const { userId: _userId, ...publicStatus } = status;
  return publicStatus;
}

function removeUnsafeBrowserKeys(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...body };
  for (const key of UNSAFE_BROWSER_KEYS) {
    delete next[key];
  }
  return next;
}

function statusCodeForError(error: unknown): number {
  if (error instanceof ImageBackendError) return error.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timed out') || message.includes('ETIMEDOUT')) {
    return 504;
  }
  if (
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('EAI_AGAIN') ||
    message.includes('ECONNRESET') ||
    message.includes('socket hang up')
  ) {
    return 502;
  }
  return 500;
}

async function saveJobStatus(status: ImageJobState): Promise<void> {
  await jsonSetWithExpiry(jobKey(status.jobId), status, IMAGE_JOB_TTL_SECONDS);
}

async function updateJobStatus(
  jobId: string,
  updates: Partial<ImageJobState>,
): Promise<ImageJobState | null> {
  const current = (await jsonGet(jobKey(jobId))) as ImageJobState | null;
  if (!current) return null;
  const next = {
    ...current,
    ...updates,
    updatedAt: Date.now(),
  };
  await saveJobStatus(next);
  return next;
}

async function rememberUserJob(userId: string, jobId: string): Promise<void> {
  const key = userJobsKey(userId);
  const existing = await jsonGet(key);
  const ids = Array.isArray(existing)
    ? existing.filter((id): id is string => typeof id === 'string')
    : [];
  await jsonSetWithExpiry(
    key,
    [jobId, ...ids.filter((id) => id !== jobId)].slice(0, MAX_USER_JOBS),
    IMAGE_JOB_TTL_SECONDS,
  );
}

async function loadOwnedJob(
  jobId: string,
  userId: string,
): Promise<ImageJobState | null> {
  const status = (await jsonGet(jobKey(jobId))) as ImageJobState | null;
  if (!status || status.userId !== userId) return null;
  return status;
}

async function loadActiveJobs(userId: string): Promise<ImageJobState[]> {
  const ids = await jsonGet(userJobsKey(userId));
  if (!Array.isArray(ids)) return [];

  const jobs = await Promise.all(
    ids
      .filter((id): id is string => typeof id === 'string')
      .map((id) => loadOwnedJob(id, userId)),
  );
  return jobs.filter(
    (job): job is ImageJobState =>
      job !== null && job.status !== 'completed' && job.status !== 'error',
  );
}

async function appendPartialImageIds(
  jobId: string,
  imageIds: string[],
): Promise<void> {
  const current = (await jsonGet(jobKey(jobId))) as ImageJobState | null;
  if (!current) return;
  const partialImageIds = Array.from(
    new Set([...current.partialImageIds, ...imageIds]),
  );
  await updateJobStatus(jobId, { partialImageIds });
}

function createHistoryEntry(job: ImageJobState): ImageHistoryEntry {
  return {
    id: `hist_${job.completedAt ?? Date.now()}_${job.jobId.slice(0, 8)}`,
    mode: job.mode,
    prompt: job.prompt,
    params: job.params,
    inputImages: job.inputImages,
    maskImage: job.maskImage,
    outputImageIds: job.outputImageIds,
    model: job.model,
    createdAt: job.completedAt ?? Date.now(),
    ...(job.usage && { usage: job.usage }),
  };
}

async function saveHistoryEntry(
  job: ImageJobState,
  entry: ImageHistoryEntry,
): Promise<void> {
  const key = historyKey(job.userId, job.sessionId);
  const existing = await jsonGet(key);
  const entries = Array.isArray(existing) ? existing : [];
  await jsonSetWithExpiry(
    key,
    [entry, ...entries.filter((item: any) => item?.id !== entry.id)].slice(
      0,
      MAX_HISTORY_ENTRIES,
    ),
    IMAGE_HISTORY_TTL_SECONDS,
  );
}

async function imageErrorMessage(res: Response): Promise<string> {
  const fallback =
    res.status === 504
      ? 'Backend timed out'
      : res.status === 502
      ? 'Backend unavailable'
      : `HTTP ${res.status}`;
  const text = await res.text();
  if (!text) return fallback;
  try {
    const json = JSON.parse(text) as {
      detail?: string;
      error?: string;
      message?: string;
    };
    return json.detail ?? json.error ?? json.message ?? fallback;
  } catch {
    return text || fallback;
  }
}

function parseImageStreamEvent(raw: string):
  | (ImageGenerationResponse & {
      type?: string;
      event?: string;
      imageId?: string;
      error?: string;
    })
  | null {
  const payload = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('event:'))
    .map((line) => line.replace(/^data:\s*/, ''))
    .join('');
  if (!payload || payload === '[DONE]') return null;

  let event: ImageGenerationResponse & {
    type?: string;
    event?: string;
    imageId?: string;
    error?: string;
  };
  try {
    event = JSON.parse(payload) as ImageGenerationResponse & {
      type?: string;
      event?: string;
      imageId?: string;
      error?: string;
    };
  } catch {
    throw new ImageBackendError(
      502,
      'Image generation stream returned an invalid event.',
    );
  }
  const type = event.type ?? event.event;
  if (type === 'error') {
    throw new ImageBackendError(
      502,
      typeof event.error === 'string'
        ? event.error
        : 'Image generation stream failed.',
    );
  }
  return event;
}

async function readImageBackendResponse(
  res: Response,
  onPartial: (imageIds: string[]) => Promise<void>,
): Promise<ImageGenerationResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  if (
    !res.body ||
    (!contentType.includes('text/event-stream') &&
      !contentType.includes('application/x-ndjson'))
  ) {
    return (await res.json()) as ImageGenerationResponse;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const boundaryPattern = contentType.includes('application/x-ndjson')
    ? /\r?\n/
    : /\r?\n\r?\n/;
  let buffer = '';
  let completed: ImageGenerationResponse | null = null;

  const handleEvent = async (raw: string) => {
    const event = parseImageStreamEvent(raw);
    if (!event) return;
    const type = event.type ?? event.event;
    const imageIds = event.imageIds ?? (event.imageId ? [event.imageId] : []);
    if (type === 'partial' && imageIds.length > 0) {
      await onPartial(imageIds);
      return;
    }
    if (type === 'completed' || imageIds.length > 0) {
      completed = event;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let boundary = boundaryPattern.exec(buffer);
    while (boundary) {
      await handleEvent(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      boundary = boundaryPattern.exec(buffer);
    }

    if (done) break;
  }

  if (buffer.trim()) await handleEvent(buffer);
  if (completed) return completed;
  throw new ImageBackendError(
    502,
    'Image generation stream ended without a completed event.',
  );
}

async function callImageBackend(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  onPartial: (imageIds: string[]) => Promise<void>,
): Promise<ImageGenerationResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ImageBackendError(res.status, await imageErrorMessage(res));
    }
    return await readImageBackendResponse(res, onPartial);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new ImageBackendError(504, 'Backend timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runImageJob(
  jobId: string,
  backendUrl: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const started = await updateJobStatus(jobId, { status: 'running' });
    if (!started) return;

    const data = await callImageBackend(
      backendUrl,
      payload,
      headers,
      async (imageIds) => {
        await appendPartialImageIds(jobId, imageIds).catch((error) => {
          console.warn('images/jobs partial status save failed:', error);
        });
      },
    );

    if (!Array.isArray(data.imageIds) || data.imageIds.length === 0) {
      throw new ImageBackendError(
        502,
        'Image response did not include generated image IDs.',
      );
    }

    const completedAt = Date.now();
    const current = (await jsonGet(jobKey(jobId))) as ImageJobState | null;
    if (!current) return;
    const historyEntry = createHistoryEntry({
      ...current,
      model: data.model ?? String(payload.model ?? ''),
      outputImageIds: data.imageIds,
      usage: data.usage,
      completedAt,
    });
    const completed = (await updateJobStatus(jobId, {
      status: 'completed',
      model: data.model ?? String(payload.model ?? ''),
      outputImageIds: data.imageIds,
      usage: data.usage,
      completedAt,
      historyEntry,
    })) as ImageJobState | null;
    if (!completed) return;
    try {
      await saveHistoryEntry(completed, historyEntry);
    } catch (error) {
      console.warn('images/jobs history save failed:', error);
    }
  } catch (error) {
    console.error('images/jobs background error:', error);
    try {
      await updateJobStatus(jobId, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Request failed',
        completedAt: Date.now(),
      });
    } catch (statusError) {
      console.error(
        'images/jobs failed to persist background error:',
        statusError,
      );
    }
  }
}

function buildPayload(
  body: Record<string, unknown>,
  mode: ImageMode,
  userId: string,
  sessionId: string,
): {
  payload: Record<string, unknown>;
  prompt: string;
  model: string;
  params: ImageParams;
  inputImages: unknown[];
  maskImage: unknown | null;
} {
  const safeBody = removeUnsafeBrowserKeys(body);
  const model = resolveImageModel(safeBody.model);
  const prompt = safeBody.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ImageBackendError(400, 'Prompt is required');
  }
  const imageRefs = safeBody.imageRefs;
  if (
    mode === 'edit' &&
    (!Array.isArray(imageRefs) || imageRefs.length === 0)
  ) {
    throw new ImageBackendError(
      400,
      'Add at least one input image or switch to Generate.',
    );
  }

  const paramsValidation = validateImageParamsForSubmit(safeBody, model);
  if (!paramsValidation.valid) {
    throw new ImageBackendError(
      400,
      paramsValidation.reason ?? 'Invalid image size',
    );
  }

  const basePayload = removeImageParamKeys(safeBody);
  delete (basePayload as Record<string, unknown>).mode;
  const params = cleanImageParamsForModel(safeBody, model);
  const payload = {
    ...basePayload,
    ...params,
    prompt: prompt.trim(),
    model,
    sessionId,
    user: userId,
  };
  if ((payload.n ?? 1) === 1) {
    Object.assign(payload, {
      stream: true,
      partial_images: STREAM_PARTIAL_IMAGES,
    });
  }

  return {
    payload,
    prompt: prompt.trim(),
    model,
    params,
    inputImages: Array.isArray(imageRefs) ? imageRefs : [],
    maskImage: safeBody.maskRef ?? null,
  };
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const body = isObject(req.body) ? req.body : {};
  const rawMode = body.mode;
  const mode: ImageMode = rawMode === 'edit' ? 'edit' : 'generate';
  if (rawMode !== undefined && rawMode !== 'generate' && rawMode !== 'edit') {
    return res.status(400).json({ error: 'Invalid image mode' });
  }

  const sessionId = getOrSetSessionId(req, res);
  const userId = session.username;
  const backendUrl = buildBackendUrl({
    backendHost: getBackendHost(),
    pathOverride:
      mode === 'generate' ? '/v1/images/generate' : '/v1/images/edit',
  });

  try {
    const built = buildPayload(body, mode, userId, sessionId);
    if (!(await enforceRateLimit(res, IMAGE_JOB_RATE_LIMIT, userId))) return;

    const activeJobs = await loadActiveJobs(userId);
    if (activeJobs.length >= MAX_ACTIVE_JOBS_PER_USER) {
      return res.status(429).json({
        error:
          'You already have two image jobs in progress. Wait for one to finish before starting another.',
      });
    }

    const jobId = randomUUID();
    const now = Date.now();
    const status: ImageJobState = {
      jobId,
      userId,
      sessionId,
      mode,
      status: 'queued',
      prompt: built.prompt,
      model: built.model,
      params: built.params,
      inputImages: built.inputImages,
      maskImage: built.maskImage,
      partialImageIds: [],
      outputImageIds: [],
      createdAt: now,
      updatedAt: now,
    };

    await saveJobStatus(status);
    await rememberUserJob(userId, jobId);

    const headers = withInternalBackendAuth(
      withTimezoneHeader(
        {
          'Content-Type': 'application/json',
          'x-user-id': userId,
          'x-session-id': sessionId,
        },
        resolveTimezoneFromHeaders(req.headers),
      ),
    );

    res.setHeader('Cache-Control', 'no-store');
    res.status(202).json({ jobId, status: 'queued' });
    void runImageJob(jobId, backendUrl, built.payload, headers).catch(
      (error) => {
        // `runImageJob` handles expected failures internally. This final guard
        // avoids an unhandled rejection if an unexpected programming error
        // occurs after the request has already received its job id.
        console.error('images/jobs unhandled background error:', error);
      },
    );
  } catch (error) {
    const statusCode = statusCodeForError(error);
    return res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const userId = session.username;
  const { jobId, active } = req.query;
  if (typeof jobId === 'string' && jobId) {
    const status = await loadOwnedJob(jobId, userId);
    if (!status) return res.status(404).json({ error: 'Job not found' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(publicJobState(status));
  }

  if (active === '1' || active === 'true') {
    const jobs = await loadActiveJobs(userId);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ jobs: jobs.map(publicJobState) });
  }

  return res.status(400).json({ error: 'Missing jobId or active=1' });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'GET') return handleGet(req, res);
  res.setHeader('Allow', ['POST', 'GET']);
  return res.status(405).json({ error: 'Method not allowed' });
}
