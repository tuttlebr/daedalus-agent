/**
 * ErrorRecovery - User-friendly error display with retry mechanisms
 *
 * Features:
 * - Human-readable error messages
 * - Contextual recovery actions
 * - Retry with exponential backoff
 * - Error categorization for appropriate UI treatment
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  IconAlertCircle,
  IconRefresh,
  IconWifi,
  IconServer,
  IconClock,
  IconX,
  IconChevronDown,
  IconChevronUp,
} from '@tabler/icons-react';

export type ErrorCategory =
  | 'network'
  | 'timeout'
  | 'server'
  | 'authentication'
  | 'rate_limit'
  | 'validation'
  | 'unknown';

export interface ErrorInfo {
  /** Original error object or message */
  error: Error | string;
  /** Categorized error type */
  category: ErrorCategory;
  /** User-friendly message */
  message: string;
  /** Technical details (shown on expand) */
  details?: string;
  /** Whether the error is recoverable */
  recoverable: boolean;
  /** Suggested retry delay in ms */
  retryDelayMs?: number;
}

export interface ErrorRecoveryProps {
  /** Error information */
  error: ErrorInfo;
  /** Callback when user clicks retry */
  onRetry?: () => void;
  /** Callback when user dismisses error */
  onDismiss?: () => void;
  /** Whether retry is in progress */
  isRetrying?: boolean;
  /** Maximum retry attempts (0 = unlimited) */
  maxRetries?: number;
  /** Current retry attempt number */
  retryAttempt?: number;
  /** Custom class name */
  className?: string;
  /** Compact mode (less vertical space) */
  compact?: boolean;
  /** Whether partial results are displayed above this error */
  isPartialResult?: boolean;
}

/**
 * Categorize an error and create user-friendly info
 */
export function categorizeError(error: Error | string): ErrorInfo {
  const errorStr = typeof error === 'string' ? error : error.message;
  const errorLower = errorStr.toLowerCase();

  // Backend unavailable / restarting (must be checked before generic network/server checks)
  if (
    errorLower.includes('backend_unavailable') ||
    errorLower.includes('backend is not reachable') ||
    /backend.*(?:not reachable|unavailable|starting|restarting)/i.test(errorStr)
  ) {
    return {
      error,
      category: 'server',
      message: 'The backend is temporarily unavailable — it may be restarting. Please wait a moment.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 30_000,
    };
  }

  // Backend queue / scheduler errors
  if (
    errorLower.includes('dask submission') ||
    errorLower.includes('scheduler unreachable') ||
    errorLower.includes('backend queue') ||
    /backend unavailable after \d+ attempts/i.test(errorStr)
  ) {
    return {
      error,
      category: 'server',
      message: 'The backend queue is temporarily unavailable. Please retry in a moment.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 5000,
    };
  }

  // Network errors
  if (
    errorLower.includes('network') ||
    errorLower.includes('fetch') ||
    errorLower.includes('failed to fetch') ||
    errorLower.includes('net::') ||
    errorLower.includes('connection')
  ) {
    return {
      error,
      category: 'network',
      message: 'Unable to connect to the server. Please check your internet connection.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 2000,
    };
  }

  // Timeout errors
  if (
    errorLower.includes('timeout') ||
    errorLower.includes('timed out') ||
    errorLower.includes('aborted') ||
    errorLower.includes('deadline') ||
    errorLower.includes('may have expired')
  ) {
    return {
      error,
      category: 'timeout',
      message: 'The request took too long. This can happen with complex tasks.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 3000,
    };
  }

  // Rate limit errors
  if (
    errorLower.includes('rate limit') ||
    errorLower.includes('too many requests') ||
    errorLower.includes('429')
  ) {
    return {
      error,
      category: 'rate_limit',
      message: 'Too many requests. Please wait a moment before trying again.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 10000,
    };
  }

  // Authentication errors
  if (
    errorLower.includes('unauthorized') ||
    errorLower.includes('authentication') ||
    errorLower.includes('401') ||
    errorLower.includes('403')
  ) {
    return {
      error,
      category: 'authentication',
      message: 'Your session may have expired. Please try signing in again.',
      details: errorStr,
      recoverable: false,
    };
  }

  // Server errors
  if (
    errorLower.includes('500') ||
    errorLower.includes('502') ||
    errorLower.includes('503') ||
    errorLower.includes('504') ||
    errorLower.includes('server error') ||
    errorLower.includes('internal error')
  ) {
    return {
      error,
      category: 'server',
      message: 'The server encountered an error. Our team has been notified.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 5000,
    };
  }

  // Validation errors
  if (
    errorLower.includes('invalid') ||
    errorLower.includes('validation') ||
    errorLower.includes('400')
  ) {
    return {
      error,
      category: 'validation',
      message: 'There was a problem with your request. Please try again.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 1000,
    };
  }

  // Agent/backend job errors
  if (
    errorLower.includes('job failed') ||
    errorLower.includes('backend job') ||
    errorLower.includes('workflow failed')
  ) {
    return {
      error,
      category: 'server',
      message: 'The agent encountered an error while processing your request.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 3000,
    };
  }

  // MCP / tool errors
  if (
    errorLower.includes('mcp') ||
    errorLower.includes('tool call') ||
    errorLower.includes('tool_call')
  ) {
    return {
      error,
      category: 'server',
      message: 'One of the agent\'s tools encountered an error.',
      details: errorStr,
      recoverable: true,
      retryDelayMs: 3000,
    };
  }

  // Unknown errors
  return {
    error,
    category: 'unknown',
    message: 'Something went wrong. Please try again.',
    details: errorStr,
    recoverable: true,
    retryDelayMs: 2000,
  };
}

/**
 * Get icon for error category
 */
function getErrorIcon(category: ErrorCategory): React.ReactNode {
  const iconClass = 'w-5 h-5';
  switch (category) {
    case 'network':
      return <IconWifi className={iconClass} />;
    case 'timeout':
      return <IconClock className={iconClass} />;
    case 'server':
      return <IconServer className={iconClass} />;
    default:
      return <IconAlertCircle className={iconClass} />;
  }
}

/**
 * Get color scheme for error category
 */
function getErrorColors(category: ErrorCategory): {
  bg: string;
  border: string;
  text: string;
  icon: string;
} {
  switch (category) {
    case 'network':
    case 'timeout':
      return {
        bg: 'bg-amber-50 dark:bg-amber-900/20',
        border: 'border-amber-200 dark:border-amber-800',
        text: 'text-amber-800 dark:text-amber-200',
        icon: 'text-amber-500',
      };
    case 'rate_limit':
      return {
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        border: 'border-blue-200 dark:border-blue-800',
        text: 'text-blue-800 dark:text-blue-200',
        icon: 'text-blue-500',
      };
    case 'authentication':
      return {
        bg: 'bg-purple-50 dark:bg-purple-900/20',
        border: 'border-purple-200 dark:border-purple-800',
        text: 'text-purple-800 dark:text-purple-200',
        icon: 'text-purple-500',
      };
    default:
      return {
        bg: 'bg-red-50 dark:bg-red-900/20',
        border: 'border-red-200 dark:border-red-800',
        text: 'text-red-800 dark:text-red-200',
        icon: 'text-red-500',
      };
  }
}

export const ErrorRecovery: React.FC<ErrorRecoveryProps> = ({
  error,
  onRetry,
  onDismiss,
  isRetrying = false,
  maxRetries = 3,
  retryAttempt = 0,
  className = '',
  compact = false,
  isPartialResult = false,
}) => {
  const [showDetails, setShowDetails] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const colors = getErrorColors(error.category);
  const canRetry = error.recoverable && (maxRetries === 0 || retryAttempt < maxRetries);

  // Handle auto-retry countdown
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    } else if (countdown === 0 && isRetrying) {
      // Countdown finished, trigger retry
    }
  }, [countdown, isRetrying]);

  const handleRetry = useCallback(() => {
    if (onRetry && canRetry && !isRetrying) {
      onRetry();
    }
  }, [onRetry, canRetry, isRetrying]);

  const handleAutoRetry = useCallback(() => {
    if (error.retryDelayMs && canRetry) {
      setCountdown(Math.ceil(error.retryDelayMs / 1000));
      setTimeout(() => {
        if (onRetry) onRetry();
      }, error.retryDelayMs);
    }
  }, [error.retryDelayMs, canRetry, onRetry]);

  return (
    <div
      className={`rounded-lg border ${colors.bg} ${colors.border} ${
        compact ? 'p-2' : 'p-4'
      } ${className}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`flex-shrink-0 ${colors.icon}`}>
          {getErrorIcon(error.category)}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Message */}
          <p className={`${compact ? 'text-sm' : 'text-base'} font-medium ${colors.text} break-words overflow-wrap-anywhere`}>
            {error.message}
          </p>

          {/* Partial result indicator */}
          {isPartialResult && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Partial results are shown above. You can retry or continue from here.
            </p>
          )}

          {/* Retry info */}
          {retryAttempt > 0 && maxRetries > 0 && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Attempt {retryAttempt} of {maxRetries}
            </p>
          )}

          {/* Details toggle */}
          {error.details && (
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="mt-2 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              {showDetails ? (
                <>
                  <IconChevronUp size={14} />
                  Hide details
                </>
              ) : (
                <>
                  <IconChevronDown size={14} />
                  Show details
                </>
              )}
            </button>
          )}

          {/* Details content */}
          {showDetails && error.details && (
            <pre className="mt-2 p-2 text-xs bg-black/5 dark:bg-white/5 rounded overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
              {error.details}
            </pre>
          )}

          {/* Actions */}
          {!compact && (canRetry || onDismiss) && (
            <div className="mt-3 flex items-center gap-2">
              {canRetry && onRetry && (
                <button
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors
                    ${
                      isRetrying
                        ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed'
                        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600'
                    }`}
                >
                  {isRetrying ? (
                    <>
                      <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                      {countdown > 0 ? `Retrying in ${countdown}s...` : 'Retrying...'}
                    </>
                  ) : (
                    <>
                      <IconRefresh size={16} />
                      Try again
                    </>
                  )}
                </button>
              )}

              {error.category === 'authentication' && (
                <a
                  href="/login"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-nvidia-green text-white hover:bg-nvidia-green/90 transition-colors"
                >
                  Sign in
                </a>
              )}
            </div>
          )}
        </div>

        {/* Dismiss button */}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="flex-shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Dismiss"
          >
            <IconX size={16} />
          </button>
        )}
      </div>

      {/* Compact retry button */}
      {compact && canRetry && onRetry && (
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors bg-white/50 dark:bg-gray-800/50 hover:bg-white dark:hover:bg-gray-800"
        >
          {isRetrying ? (
            <div className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <IconRefresh size={12} />
          )}
          {isRetrying ? 'Retrying...' : 'Retry'}
        </button>
      )}
    </div>
  );
};

/**
 * Inline error indicator (for use in message bubbles)
 */
export const InlineError: React.FC<{
  message: string;
  onRetry?: () => void;
}> = ({ message, onRetry }) => {
  return (
    <span className="inline-flex items-center gap-1 text-red-500 dark:text-red-400 text-sm">
      <IconAlertCircle size={14} />
      {message}
      {onRetry && (
        <button
          onClick={onRetry}
          className="ml-1 underline hover:no-underline"
        >
          Retry
        </button>
      )}
    </span>
  );
};

export default ErrorRecovery;
