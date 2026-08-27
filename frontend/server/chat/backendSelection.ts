import {
  buildBackendBaseUrl,
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
  getBackendPodDiscoveryHost,
} from '@/utils/app/backendApi';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { Logger } from '@/utils/logger';

import {
  NAT_BACKEND_CACHE_TTL_MS,
  NAT_CONNECTIVITY_TIMEOUT_MS,
  NAT_RETRY_DELAY_MS,
  NAT_SUBMIT_MAX_RETRIES,
  sleep,
} from './constants';
import { buildNatRequestHeaders } from './natMessages';
import { ApiRouteError, type AsyncJobRequest } from './types';

import { resolve4 } from 'node:dns/promises';

const logger = new Logger('AsyncJob');

// Per-process stickiness cache for the pinned backend pod (one instance per
// Node process via the module cache — same semantics as before extraction).
let cachedStreamBackend: { baseUrl: string; expiresAt: number } | null = null;

/** Drop the pinned backend so the next selection re-probes. Used by tests. */
export function resetStreamBackendPin(): void {
  cachedStreamBackend = null;
}

function shuffleItems<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function getNatBaseUrl(jobRequest: AsyncJobRequest): string {
  return jobRequest.natBaseUrl;
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
  timezone?: string,
): Promise<string> {
  const natBaseUrls = await resolveAsyncBackendBaseUrls();
  const now = Date.now();
  const cacheIsFresh = Boolean(
    cachedStreamBackend &&
      cachedStreamBackend.expiresAt > now &&
      natBaseUrls.includes(cachedStreamBackend.baseUrl),
  );

  // Reuse the pinned backend without re-probing. The probe exists to pick a
  // reachable pod, so a fresh pin means that choice is already made; probing
  // again only adds a synchronous round trip to every chat submit. DNS still
  // gates the reuse above, so a pod that left the endpoint set is not pinned.
  if (cacheIsFresh) {
    return cachedStreamBackend!.baseUrl;
  }

  const candidates = natBaseUrls;

  logger.info(`Job ${jobId}: Resolved async backend candidates`, {
    candidateCount: candidates.length,
    candidates,
    cachedCandidate: cachedStreamBackend?.baseUrl || null,
  });

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= NAT_SUBMIT_MAX_RETRIES; attempt++) {
    for (const natBaseUrl of candidates) {
      // /health is the endpoint the Kubernetes startupProbe uses. /docs is the
      // Swagger UI: it renders regardless of workflow health and is disabled in
      // some deployments. /health/ready is deliberately not used here because it
      // reports 503 for optional subsystems (RAG, memory) that chat can run
      // without.
      const healthUrl = buildBackendUrlFromBase(natBaseUrl, '/health');
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
            headers: buildNatRequestHeaders(
              verifiedUsername,
              {},
              natSessionId,
              timezone,
            ),
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
