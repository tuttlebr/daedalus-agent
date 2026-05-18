import type { MessageError } from '@/types/chat';
import { ApiError } from './api';
import { FetchTimeoutError } from '@/utils/fetchWithTimeout';

export type ErrorCategory = NonNullable<MessageError['category']>;

const NETWORK_HINTS = ['failed to fetch', 'network', 'load failed', 'connection', 'offline'];
const TIMEOUT_HINTS = ['timed out', 'timeout', 'did not respond'];
const RATE_LIMIT_HINTS = ['rate limit', 'too many requests', '429'];
const AUTH_HINTS = ['unauthorized', 'forbidden', '401', '403'];

export function categorizeError(error: unknown): ErrorCategory {
  if (error instanceof FetchTimeoutError) return 'timeout';
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'auth': return 'authentication';
      case 'server': return 'server';
      case 'network': return 'network';
      case 'timeout': return 'timeout';
      case 'client':
        if (error.status === 429) return 'rate_limit';
        return 'unknown';
      default: return 'unknown';
    }
  }
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (TIMEOUT_HINTS.some((h) => msg.includes(h))) return 'timeout';
  if (NETWORK_HINTS.some((h) => msg.includes(h))) return 'network';
  if (RATE_LIMIT_HINTS.some((h) => msg.includes(h))) return 'rate_limit';
  if (AUTH_HINTS.some((h) => msg.includes(h))) return 'authentication';
  if (msg.includes('5') && (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504'))) {
    return 'server';
  }
  return 'unknown';
}

const RECOVERABLE: ErrorCategory[] = ['network', 'timeout', 'server', 'rate_limit'];

export function isRecoverable(category: ErrorCategory): boolean {
  return RECOVERABLE.includes(category);
}

const FRIENDLY: Record<ErrorCategory, string> = {
  network: 'Connection lost. Check your network and try again.',
  timeout: 'The server took too long to respond. Try again.',
  server: 'The server hit an unexpected error. Please try again.',
  rate_limit: 'Too many requests. Wait a moment, then try again.',
  authentication: 'Your session expired. Please sign in again.',
  unknown: 'Something went wrong.',
};

export function friendlyMessage(category: ErrorCategory, fallback?: string): string {
  if (category === 'unknown' && fallback) return fallback;
  return FRIENDLY[category];
}

export function buildMessageError(error: unknown, fallback?: string): MessageError {
  const category = categorizeError(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    message: friendlyMessage(category, fallback ?? rawMessage),
    category,
    details: rawMessage,
    timestamp: Date.now(),
    recoverable: isRecoverable(category),
  };
}
