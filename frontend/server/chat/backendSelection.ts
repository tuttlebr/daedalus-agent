import {
  buildBackendBaseUrl,
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
  getBackendPodDiscoveryHost,
} from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { Logger } from '@/utils/logger';

import {
  JOB_EXPIRY_SECONDS,
  NAT_BACKEND_CACHE_TTL_MS,
  NAT_CONNECTIVITY_TIMEOUT_MS,
  NAT_RETRY_DELAY_MS,
  NAT_SUBMIT_MAX_RETRIES,
  NAT_SUBMIT_TIMEOUT_MS,
  sleep,
} from './constants';
import { buildNatRequestHeaders } from './natMessages';
import {
  ApiRouteError,
  type AsyncJobRequest,
  type NatAsyncJobResponse,
} from './types';

import { resolve4 } from 'node:dns/promises';

const logger = new Logger('AsyncJob');

// Per-process stickiness cache for the pinned backend pod (one instance per
// Node process via the module cache — same semantics as before extraction).
let cachedStreamBackend: { baseUrl: string; expiresAt: number } | null = null;

function shuffleItems<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function getNatBaseUrl(jobRequest: AsyncJobRequest): string {
  // Legacy fallback for jobs created before backend pinning was deployed.
  return jobRequest.natBaseUrl || buildBackendBaseUrlForMode();
}

export async function resolveAsyncBackendBaseUrls(): Promise<string[]> {
  const fallbackBaseUrl = buildBackendBaseUrlForMode();
  const isKubernetes =
    process.env.KUBERNETES_SERVICE_HOST ||
    process.env.DEPLOYMENT_MODE === 'kubernetes';

  if (!isKubernetes) {
    return [fallbackBaseUrl];
  }

  try {
    const discoveryHost = getBackendPodDiscoveryHost();
    const resolvedIps = await resolve4(discoveryHost);
    const uniqueIps = Array.from(new Set(resolvedIps));

    if (uniqueIps.length === 0) {
      logger.warn(
        `No backend pod IPs resolved for ${discoveryHost}; falling back to service URL ${fallbackBaseUrl}`,
      );
      return [fallbackBaseUrl];
    }

    return shuffleItems(uniqueIps).map((backendHost) =>
      buildBackendBaseUrl({ backendHost }),
    );
  } catch (error: any) {
    logger.warn(
      `Backend pod discovery failed; falling back to service URL ${fallbackBaseUrl}`,
      error,
    );
    return [fallbackBaseUrl];
  }
}

export async function selectStreamBackendBaseUrl(
  jobId: string,
  verifiedUsername: string,
  natSessionId: string,
): Promise<string> {
  const natBaseUrls = await resolveAsyncBackendBaseUrls();
  const now = Date.now();
  const candidates =
    cachedStreamBackend &&
    cachedStreamBackend.expiresAt > now &&
    natBaseUrls.includes(cachedStreamBackend.baseUrl)
      ? [
          cachedStreamBackend.baseUrl,
          ...natBaseUrls.filter((url) => url !== cachedStreamBackend!.baseUrl),
        ]
      : natBaseUrls;

  logger.info(`Job ${jobId}: Resolved async backend candidates`, {
    candidateCount: candidates.length,
    candidates,
    cachedCandidate: cachedStreamBackend?.baseUrl || null,
  });

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= NAT_SUBMIT_MAX_RETRIES; attempt++) {
    for (const natBaseUrl of candidates) {
      const healthUrl = buildBackendUrlFromBase(natBaseUrl, '/docs');
      const streamUrl = buildBackendUrlFromBase(
        natBaseUrl,
        '/v1/chat/completions',
      );

      logger.info(`Job ${jobId}: Checking stream backend at ${streamUrl}`, {
        attempt,
        maxAttempts: NAT_SUBMIT_MAX_RETRIES,
        natBaseUrl,
      });

      try {
        const healthResponse = await fetchWithTimeout(
          healthUrl,
          {
            method: 'HEAD',
            headers: buildNatRequestHeaders(verifiedUsername, {}, natSessionId),
          },
          NAT_CONNECTIVITY_TIMEOUT_MS,
        );
        if (!healthResponse.ok) {
          throw new Error(`HTTP ${healthResponse.status}`);
        }
        cachedStreamBackend = {
          baseUrl: natBaseUrl,
          expiresAt: Date.now() + NAT_BACKEND_CACHE_TTL_MS,
        };
        return natBaseUrl;
      } catch (err: any) {
        if (cachedStreamBackend?.baseUrl === natBaseUrl) {
          cachedStreamBackend = null;
        }
        lastError = `connectivity check failed for ${natBaseUrl}: ${
          err.message || 'Unknown fetch error'
        }`;
        logger.warn(
          `Job ${jobId}: Stream backend check failed on ${natBaseUrl} (attempt ${attempt}/${NAT_SUBMIT_MAX_RETRIES}): ${lastError}`,
        );
      }
    }

    if (attempt < NAT_SUBMIT_MAX_RETRIES) {
      logger.info(`Job ${jobId}: Retrying in ${NAT_RETRY_DELAY_MS}ms...`);
      await sleep(NAT_RETRY_DELAY_MS);
    }
  }

  throw new ApiRouteError(
    502,
    `Backend unavailable after ${NAT_SUBMIT_MAX_RETRIES} attempts: ${lastError}`,
    'backend_unavailable',
  );
}

export async function submitNatAsyncJob(
  jobId: string,
  natBaseUrl: string,
  messagesForNat: any[],
  verifiedUsername: string,
  natSessionId: string,
): Promise<void> {
  const submitUrl = buildBackendUrlFromBase(natBaseUrl, '/v1/workflow/async');
  const payload = {
    input_message: messagesToInputMessage(messagesForNat),
    job_id: jobId,
    sync_timeout: 0,
    expiry_seconds: JOB_EXPIRY_SECONDS,
  };

  const response = await fetchWithTimeout(
    submitUrl,
    {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json' },
        natSessionId,
      ),
      body: JSON.stringify(payload),
    },
    NAT_SUBMIT_TIMEOUT_MS,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new ApiRouteError(
      response.status >= 500 ? 502 : response.status,
      `Backend async job submission failed (${response.status})${
        errorText ? `: ${errorText}` : ''
      }`,
      'backend_submit_failed',
    );
  }
}

function messagesToInputMessage(messages: any[]): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const rawContent = message.content;
      const content =
        typeof rawContent === 'string'
          ? rawContent.trim()
          : JSON.stringify(rawContent ?? '').trim();
      if (!content) return null;
      const role = String(message.role || 'user').trim().toUpperCase() || 'USER';
      return `[${role}]\n${content}`;
    })
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

export async function fetchNatJobStatus(
  jobId: string,
  jobRequest: AsyncJobRequest,
): Promise<NatAsyncJobResponse | null> {
  const natStatusUrl = buildBackendUrlFromBase(
    getNatBaseUrl(jobRequest),
    `/v1/workflow/async/job/${encodeURIComponent(jobId)}`,
  );
  const natResponse = await fetchWithTimeout(
    natStatusUrl,
    {
      headers: buildNatRequestHeaders(
        jobRequest.userId,
        {},
        jobRequest.natSessionId,
      ),
    },
    30_000,
  );

  if (!natResponse.ok) {
    if (natResponse.status === 404) {
      if (!jobRequest.natBaseUrl) {
        logger.warn(
          `Job ${jobId}: Received 404 from legacy shared backend route; leaving job pending for retry`,
        );
        return null;
      }
      return {
        job_id: jobId,
        status: 'failure',
        error: 'Job not found on backend (may have expired)',
        output: null,
        created_at: '',
        updated_at: '',
        expires_at: '',
      };
    }
    throw new Error(`NAT returned ${natResponse.status}`);
  }

  return natResponse.json();
}
