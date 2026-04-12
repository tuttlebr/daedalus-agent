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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

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
 * Get the backend host based on environment.
 *
 * @returns The backend hostname (with Kubernetes FQDN if in K8s environment)
 */
export function getBackendHost(): string {
  const baseHost = process.env.BACKEND_HOST || 'daedalus-backend';
  const backendNamespace =
    process.env.BACKEND_NAMESPACE ||
    process.env.POD_NAMESPACE ||
    process.env.NAMESPACE ||
    'daedalus';
  const isKubernetes =
    process.env.KUBERNETES_SERVICE_HOST || process.env.DEPLOYMENT_MODE === 'kubernetes';

  if (isKubernetes) {
    return `${baseHost}-default.${backendNamespace}.svc.cluster.local`;
  }
  return baseHost;
}

/**
 * Get the headless service host used for backend pod discovery.
 *
 * @returns The discovery hostname (pod-backed in Kubernetes)
 */
export function getBackendPodDiscoveryHost(): string {
  const baseHost = process.env.BACKEND_HOST || 'daedalus-backend';
  const backendNamespace =
    process.env.BACKEND_NAMESPACE ||
    process.env.POD_NAMESPACE ||
    process.env.NAMESPACE ||
    'daedalus';
  const isKubernetes =
    process.env.KUBERNETES_SERVICE_HOST || process.env.DEPLOYMENT_MODE === 'kubernetes';

  if (isKubernetes) {
    return `${baseHost}-default-pods.${backendNamespace}.svc.cluster.local`;
  }

  return getBackendHost();
}

/**
 * Build the base backend URL without any path.
 *
 * @param options - Configuration options
 * @param options.backendHost - The backend hostname or IP
 * @param options.port - The port number (defaults to BACKEND_PORT)
 * @returns The backend base URL
 */
export function buildBackendBaseUrl(options: {
  backendHost: string;
  port?: string | number;
}): string {
  const { backendHost, port = BACKEND_PORT } = options;
  return normalizeBaseUrl(`http://${backendHost}:${port}`);
}

/**
 * Build the base backend URL for the default backend.
 *
 * @param port - Optional port override
 * @returns The backend base URL
 */
export function buildBackendBaseUrlForMode(
  port?: string | number
): string {
  const backendHost = getBackendHost();
  return buildBackendBaseUrl({ backendHost, port });
}

/**
 * Build a backend URL from an explicit base URL.
 *
 * @param baseUrl - The base backend URL
 * @param pathOverride - Optional path override (defaults to BACKEND_API_PATH)
 * @returns The full backend URL
 */
export function buildBackendUrlFromBase(baseUrl: string, pathOverride?: string): string {
  const path = pathOverride || BACKEND_API_PATH;
  return `${normalizeBaseUrl(baseUrl)}${path}`;
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
  return buildBackendUrlFromBase(
    buildBackendBaseUrl({ backendHost, port }),
    pathOverride,
  );
}

/**
 * Build the full backend URL for the default backend.
 *
 * @param pathOverride - Optional path override (defaults to BACKEND_API_PATH)
 * @returns The full backend URL
 */
export function buildBackendUrlForMode(
  pathOverride?: string
): string {
  const backendHost = getBackendHost();
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
  return buildBackendUrlForMode();
}

/**
 * Build the URL for submitting an async workflow job to NAT.
 * POST /v1/workflow/async
 *
 * @returns The full URL for the async job submission endpoint
 */
export function buildAsyncJobSubmitUrl(): string {
  const backendHost = getBackendHost();
  return buildBackendUrl({ backendHost, pathOverride: '/v1/workflow/async' });
}

/**
 * Build the URL for checking async workflow job status from NAT.
 * GET /v1/workflow/async/job/{jobId}
 *
 * @param jobId - The job identifier
 * @returns The full URL for the async job status endpoint
 */
export function buildAsyncJobStatusUrl(jobId: string): string {
  const backendHost = getBackendHost();
  return buildBackendUrl({
    backendHost,
    pathOverride: `/v1/workflow/async/job/${encodeURIComponent(jobId)}`,
  });
}
