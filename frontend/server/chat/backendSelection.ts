import {
  BACKEND_POD_PORT,
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
const MAX_CONCURRENT_HEALTH_PROBES = 3;

export const BACKEND_UNAVAILABLE_MESSAGE =
  'The assistant backend is temporarily unavailable. Please try again shortly.';

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
      buildBackendBaseUrl({ backendHost, port: BACKEND_POD_PORT }),
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
    const probes = new AbortController();
    let nextCandidate = 0;
    // Race a bounded pool of status-only GETs. A slow/unreachable pod must
    // not hide a healthy sibling behind its connection timeout. Only health
    // checks race; the job is still sent to exactly one selected backend.
    const probeNext = async (): Promise<string> => {
      while (!probes.signal.aborted && nextCandidate < candidates.length) {
        const natBaseUrl = candidates[nextCandidate++];
        // /health is the endpoint the Kubernetes startupProbe uses. /docs is the
        // Swagger UI: it renders regardless of workflow health and is disabled in
        // some deployments. /health/ready is deliberately not used here because it
        // reports 503 for optional subsystems (RAG, memory) that chat can run
        // without. The probe must use GET: the backend is FastAPI, which does not
        // register HEAD handlers for GET-only routes, so HEAD /health returns 405
        // and would mark every healthy pod unreachable.
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
              method: 'GET',
              signal: probes.signal,
              headers: buildNatRequestHeaders(
                verifiedUsername,
                {},
                natSessionId,
                timezone,
              ),
            },
            NAT_CONNECTIVITY_TIMEOUT_MS,
          );
          // Health selection uses only status; release the bounded response body.
          await healthResponse.body?.cancel();
          if (!healthResponse.ok) {
            throw new Error(`HTTP ${healthResponse.status}`);
          }
          return natBaseUrl;
        } catch (err: any) {
          if (probes.signal.aborted) throw err;
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
      throw new Error('No reachable backend in health probe pool');
    };
    try {
      const natBaseUrl = await Promise.any(
        Array.from(
          { length: Math.min(MAX_CONCURRENT_HEALTH_PROBES, candidates.length) },
          probeNext,
        ),
      );
      cachedStreamBackend = {
        baseUrl: natBaseUrl,
        expiresAt: Date.now() + NAT_BACKEND_CACHE_TTL_MS,
      };
      return natBaseUrl;
    } catch {
      // Every candidate failed; retain the existing bounded retry policy.
    } finally {
      // Promise.any observes all losers; abort releases their sockets/timers.
      probes.abort();
    }

    if (attempt < NAT_SUBMIT_MAX_RETRIES) {
      logger.info(`Job ${jobId}: Retrying in ${NAT_RETRY_DELAY_MS}ms...`);
      await sleep(NAT_RETRY_DELAY_MS);
    }
  }

  // The message reaches the browser and saved chats. Pod addresses and probe
  // errors stay in the server log above.
  logger.error(
    `Job ${jobId}: no stream backend reachable after ${NAT_SUBMIT_MAX_RETRIES} attempts`,
    { lastError },
  );
  throw new ApiRouteError(
    502,
    BACKEND_UNAVAILABLE_MESSAGE,
    'backend_unavailable',
  );
}
