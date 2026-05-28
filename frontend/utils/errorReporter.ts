import { Logger } from './logger';

const logger = new Logger('ErrorReporter');

export type ErrorSource =
  | 'react-render'
  | 'unhandled-rejection'
  | 'window-error'
  | 'manual';

export interface ErrorContext {
  source: ErrorSource;
  componentStack?: string;
  url?: string;
  userAgent?: string;
}

type Reporter = (error: unknown, context: ErrorContext) => void;

let externalReporter: Reporter | null = null;

export function setErrorReporter(reporter: Reporter | null): void {
  externalReporter = reporter;
}

export function reportError(
  error: unknown,
  context: Partial<ErrorContext> = {},
): void {
  const enriched: ErrorContext = {
    source: 'manual',
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    userAgent:
      typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    ...context,
  };

  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[${enriched.source}] ${message}`, error);

  if (externalReporter) {
    try {
      externalReporter(error, enriched);
    } catch (reporterError) {
      logger.error('External reporter threw', reporterError);
    }
  }
}

const SAFE_PROD_MESSAGE =
  'An unexpected error occurred. Please try again or reload.';

export function userFacingMessage(error: unknown): string {
  if (process.env.NODE_ENV !== 'production') {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  return SAFE_PROD_MESSAGE;
}
