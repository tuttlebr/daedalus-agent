/**
 * Protocol-neutral errors for the compatibility endpoints. Each encoder maps
 * a kind to its vendor's status code and error body.
 *
 * `retryable` becomes the `x-should-retry` header, which the official OpenAI
 * and Anthropic SDKs obey ahead of their status-code retry rules. Only
 * failures that happened before a run could act are retryable: an automatic
 * SDK retry of a run that may have used tools would repeat its actions.
 */
export type CompatErrorKind =
  | 'invalid_request'
  | 'authentication'
  | 'authorization_required'
  | 'not_found'
  | 'conflict'
  | 'request_too_large'
  | 'rate_limit'
  | 'overloaded'
  | 'api_error';

export interface CompatErrorDetails {
  runId?: string;
  conversationId?: string;
  /** A Daedalus page where the user completes the required action. */
  actionUrl?: string;
  requirement?: 'mcp_approval' | 'oauth';
}

export class CompatError extends Error {
  readonly kind: CompatErrorKind;
  readonly code?: string;
  readonly param?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: CompatErrorDetails;

  constructor(
    kind: CompatErrorKind,
    message: string,
    options: {
      code?: string;
      param?: string;
      retryable?: boolean;
      retryAfterSeconds?: number;
      details?: CompatErrorDetails;
    } = {},
  ) {
    super(message);
    this.name = 'CompatError';
    this.kind = kind;
    this.code = options.code;
    this.param = options.param;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

export function invalidRequest(
  message: string,
  param?: string,
  code = 'invalid_value',
): CompatError {
  return new CompatError('invalid_request', message, { param, code });
}

/** The `daedalus` extension object carried inside vendor error bodies. */
export function errorExtension(
  details: CompatErrorDetails | undefined,
): Record<string, string> | undefined {
  if (!details) return undefined;
  const extension: Record<string, string> = {};
  if (details.runId) extension.run_id = details.runId;
  if (details.conversationId)
    extension.conversation_id = details.conversationId;
  if (details.actionUrl) extension.action_url = details.actionUrl;
  if (details.requirement) extension.requirement = details.requirement;
  return Object.keys(extension).length ? extension : undefined;
}
