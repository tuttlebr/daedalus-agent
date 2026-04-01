/**
 * Centralized Backend API Configuration
 *
 * This module provides a single source of truth for backend API path configuration.
 * It supports multiple NAT API formats:
 * - /chat, /chat/stream (default NAT chat endpoints)
 * - /generate, /generate/stream (NAT generate endpoints)
 * - /v1/chat/completions (OpenAI-compatible endpoint)
 */

// Backend API path configuration
// Supported values: '/chat', '/chat/stream', '/generate', '/generate/stream', '/v1/chat/completions'
export const BACKEND_API_PATH = process.env.BACKEND_API_PATH || '/chat';

// Default backend port
export const BACKEND_PORT = process.env.BACKEND_PORT || '8000';

/**
 * Check if using generate endpoint (requires different payload format)
 */
export const isGenerateEndpoint = (): boolean => BACKEND_API_PATH.includes('generate');

/**
 * Check if using OpenAI v1 compatible endpoint
 */
export const isOpenAIv1Endpoint = (): boolean => BACKEND_API_PATH.includes('/v1/');

/**
 * Check if using a streaming endpoint
 */
export const isStreamingEndpoint = (): boolean =>
  BACKEND_API_PATH.includes('/stream') || BACKEND_API_PATH.includes('/v1/');

/**
 * Get the backend host based on environment and deep thinker flag
 *
 * @param useDeepThinker - Whether to use the deep thinker backend
 * @returns The backend hostname (with Kubernetes FQDN if in K8s environment)
 */
export function getBackendHost(useDeepThinker: boolean): string {
  const baseHost = process.env.BACKEND_HOST || 'daedalus-backend';
  const isKubernetes =
    process.env.KUBERNETES_SERVICE_HOST || process.env.DEPLOYMENT_MODE === 'kubernetes';

  if (isKubernetes) {
    const suffix = useDeepThinker ? '-deep-thinker' : '-default';
    return `${baseHost}${suffix}.daedalus.svc.cluster.local`;
  }
  return baseHost;
}

/**
 * Build the full backend URL
 *
 * @param options - Configuration options
 * @param options.backendHost - The backend hostname
 * @param options.port - The port number (defaults to BACKEND_PORT)
 * @param options.pathOverride - Optional path override (defaults to BACKEND_API_PATH)
 * @returns The full backend URL
 */
export function buildBackendUrl(options: {
  backendHost: string;
  port?: string | number;
  pathOverride?: string;
}): string {
  const { backendHost, port = BACKEND_PORT, pathOverride } = options;
  const path = pathOverride || BACKEND_API_PATH;
  return `http://${backendHost}:${port}${path}`;
}

/**
 * Build the full backend URL for a specific deep thinker mode
 *
 * @param useDeepThinker - Whether to use the deep thinker backend
 * @param pathOverride - Optional path override (defaults to BACKEND_API_PATH)
 * @returns The full backend URL
 */
export function buildBackendUrlForMode(
  useDeepThinker: boolean,
  pathOverride?: string
): string {
  const backendHost = getBackendHost(useDeepThinker);
  return buildBackendUrl({ backendHost, pathOverride });
}

/**
 * Get the default chat completion URL for UI state initialization
 * Uses environment variable override if available, otherwise builds from config
 *
 * @returns The default chat completion URL
 */
export function getDefaultChatCompletionUrl(): string {
  // Allow full URL override via environment variable
  if (process.env.NEXT_PUBLIC_HTTP_CHAT_COMPLETION_URL) {
    return process.env.NEXT_PUBLIC_HTTP_CHAT_COMPLETION_URL;
  }
  // Build URL using centralized config (default backend)
  return buildBackendUrlForMode(false);
}

/**
 * Build the URL for submitting an async workflow job to NAT.
 * POST /v1/workflow/async
 *
 * @param useDeepThinker - Whether to route to the deep-thinker backend
 * @returns The full URL for the async job submission endpoint
 */
export function buildAsyncJobSubmitUrl(useDeepThinker: boolean): string {
  const backendHost = getBackendHost(useDeepThinker);
  return buildBackendUrl({ backendHost, pathOverride: '/v1/workflow/async' });
}

/**
 * Build the URL for checking async workflow job status from NAT.
 * GET /v1/workflow/async/job/{jobId}
 *
 * @param useDeepThinker - Whether to route to the deep-thinker backend
 * @param jobId - The job identifier
 * @returns The full URL for the async job status endpoint
 */
export function buildAsyncJobStatusUrl(useDeepThinker: boolean, jobId: string): string {
  const backendHost = getBackendHost(useDeepThinker);
  return buildBackendUrl({
    backendHost,
    pathOverride: `/v1/workflow/async/job/${encodeURIComponent(jobId)}`,
  });
}
