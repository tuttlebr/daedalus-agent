import type { NextApiResponse } from 'next';

import {
  type CompatError,
  type CompatErrorKind,
  errorExtension,
} from './errors';

import type { RunUsage } from '@/server/chat/types';

/** The answer a run produced, after the final-answer budget was applied. */
export interface CompatCompletion {
  text: string;
  truncated: boolean;
  usage?: RunUsage;
}

/**
 * Writes one protocol's response. Errors before `startStream` are ordinary
 * HTTP errors; after it, they become the protocol's in-stream error event.
 */
export interface CompatResponder {
  readonly streaming: boolean;
  sendError(error: CompatError): void;
  sendCompletion(result: CompatCompletion): void;
  startStream(): void;
  keepalive(): void;
  finishStream(result: CompatCompletion): void;
  failStream(error: CompatError): void;
}

export interface ResponderOptions {
  runId: string;
  model: string;
  stream: boolean;
  includeUsage: boolean;
  /** Unix seconds; fixed per response. */
  created?: number;
}

// Large answers are split so no single SSE frame grows without bound.
const STREAM_TEXT_CHUNK = 4096;

function chunks(text: string): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + STREAM_TEXT_CHUNK, text.length);
    // Never split a surrogate pair across frames.
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    parts.push(text.slice(index, end));
    index = end;
  }
  return parts;
}

function writeJsonError(
  res: NextApiResponse,
  status: number,
  error: CompatError,
  body: unknown,
): void {
  res.setHeader('x-should-retry', error.retryable ? 'true' : 'false');
  if (error.retryAfterSeconds !== undefined) {
    res.setHeader('retry-after', String(error.retryAfterSeconds));
  }
  res.status(status).json(body);
}

function startEventStream(res: NextApiResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform keeps response compression from buffering the stream.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function write(res: NextApiResponse, frame: string): void {
  if (!res.writableEnded && !res.destroyed) res.write(frame);
}

function end(res: NextApiResponse): void {
  if (!res.writableEnded) res.end();
}

// ── OpenAI Chat Completions ────────────────────────────────────────────

const OPENAI_STATUS: Record<
  CompatErrorKind,
  { status: number; type: string; code?: string }
> = {
  invalid_request: { status: 400, type: 'invalid_request_error' },
  authentication: {
    status: 401,
    type: 'invalid_request_error',
    code: 'invalid_api_key',
  },
  authorization_required: {
    status: 403,
    type: 'permission_error',
    code: 'authorization_required',
  },
  not_found: { status: 404, type: 'invalid_request_error' },
  conflict: { status: 409, type: 'invalid_request_error' },
  request_too_large: { status: 413, type: 'invalid_request_error' },
  rate_limit: {
    status: 429,
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
  },
  overloaded: { status: 503, type: 'server_error', code: 'overloaded' },
  api_error: { status: 502, type: 'server_error' },
};

export function openAIErrorBody(error: CompatError): {
  status: number;
  body: Record<string, unknown>;
} {
  const mapping = OPENAI_STATUS[error.kind];
  const extension = errorExtension(error.details);
  return {
    status: mapping.status,
    body: {
      error: {
        message: error.message,
        type: mapping.type,
        param: error.param ?? null,
        code: error.code ?? mapping.code ?? null,
        ...(extension ? { daedalus: extension } : {}),
      },
    },
  };
}

/** Chat Completions usage only when every model call reported it. */
export function openAIUsage(
  usage: RunUsage | undefined,
): Record<string, unknown> | null {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedTokens !== null
      ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }
      : {}),
  };
}

export function createOpenAIResponder(
  res: NextApiResponse,
  options: ResponderOptions,
): CompatResponder {
  const id = `chatcmpl-${options.runId}`;
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const chunk = (
    choices: unknown[],
    extra: Record<string, unknown> = {},
  ): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: options.model,
      system_fingerprint: null,
      choices,
      ...(options.includeUsage ? { usage: null } : {}),
      ...extra,
    })}\n\n`;
  const finishReason = (result: CompatCompletion) =>
    result.truncated ? 'length' : 'stop';

  return {
    streaming: options.stream,
    sendError(error) {
      const { status, body } = openAIErrorBody(error);
      writeJsonError(res, status, error, body);
    },
    sendCompletion(result) {
      const usage = openAIUsage(result.usage);
      res.status(200).json({
        id,
        object: 'chat.completion',
        created,
        model: options.model,
        system_fingerprint: null,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
              refusal: null,
              annotations: [],
            },
            logprobs: null,
            finish_reason: finishReason(result),
          },
        ],
        ...(usage ? { usage } : {}),
      });
    },
    startStream() {
      startEventStream(res);
      write(
        res,
        chunk([
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            logprobs: null,
            finish_reason: null,
          },
        ]),
      );
    },
    keepalive() {
      write(res, ': keepalive\n\n');
    },
    finishStream(result) {
      for (const part of chunks(result.text)) {
        write(
          res,
          chunk([
            {
              index: 0,
              delta: { content: part },
              logprobs: null,
              finish_reason: null,
            },
          ]),
        );
      }
      write(
        res,
        chunk([
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: finishReason(result),
          },
        ]),
      );
      const usage = openAIUsage(result.usage);
      if (options.includeUsage && usage) write(res, chunk([], { usage }));
      write(res, 'data: [DONE]\n\n');
      end(res);
    },
    failStream(error) {
      // The SDKs raise an APIError for a data frame carrying `error`.
      write(res, `data: ${JSON.stringify(openAIErrorBody(error).body)}\n\n`);
      end(res);
    },
  };
}

// ── Anthropic Messages ─────────────────────────────────────────────────

const ANTHROPIC_STATUS: Record<
  CompatErrorKind,
  { status: number; type: string }
> = {
  invalid_request: { status: 400, type: 'invalid_request_error' },
  authentication: { status: 401, type: 'authentication_error' },
  authorization_required: { status: 403, type: 'permission_error' },
  not_found: { status: 404, type: 'not_found_error' },
  conflict: { status: 409, type: 'invalid_request_error' },
  request_too_large: { status: 413, type: 'request_too_large' },
  rate_limit: { status: 429, type: 'rate_limit_error' },
  overloaded: { status: 529, type: 'overloaded_error' },
  api_error: { status: 502, type: 'api_error' },
};

export function anthropicErrorBody(
  error: CompatError,
  requestId?: string,
): { status: number; body: Record<string, unknown> } {
  const mapping = ANTHROPIC_STATUS[error.kind];
  const extension = errorExtension(error.details);
  return {
    status: mapping.status,
    body: {
      type: 'error',
      error: {
        type: mapping.type,
        message: error.message,
        ...(extension ? { daedalus: extension } : {}),
      },
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

/**
 * Messages usage. The schema requires numbers, so when some model call did
 * not report usage these are the measured lower bounds (never estimates);
 * `usageCompleteness` reports which case applies.
 */
export function anthropicUsage(usage: RunUsage | undefined): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: null;
  cache_read_input_tokens: number | null;
  [field: string]: number | null;
} {
  const input = usage?.inputTokens ?? usage?.reportedInputTokens ?? 0;
  const output = usage?.outputTokens ?? usage?.reportedOutputTokens ?? 0;
  const cached = usage ? usage.cachedTokens : null;
  // Messages counts cache reads separately from uncached input.
  return {
    input_tokens: cached !== null ? Math.max(0, input - cached) : input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: cached,
    // Current schema fields Daedalus does not measure.
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

export function usageCompleteness(
  usage: RunUsage | undefined,
): 'complete' | 'partial' | 'unavailable' {
  if (!usage) return 'unavailable';
  if (usage.inputTokens !== null && usage.outputTokens !== null)
    return 'complete';
  return usage.reportedInputTokens || usage.reportedOutputTokens
    ? 'partial'
    : 'unavailable';
}

export function createAnthropicResponder(
  res: NextApiResponse,
  options: ResponderOptions,
): CompatResponder {
  const id = `msg_${options.runId.replace(/-/g, '')}`;
  const event = (name: string, data: unknown) =>
    write(res, `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const stopReason = (result: CompatCompletion) =>
    result.truncated ? 'max_tokens' : 'end_turn';

  return {
    streaming: options.stream,
    sendError(error) {
      const { status, body } = anthropicErrorBody(error, options.runId);
      writeJsonError(res, status, error, body);
    },
    sendCompletion(result) {
      res.setHeader('x-daedalus-usage', usageCompleteness(result.usage));
      res.status(200).json({
        id,
        type: 'message',
        role: 'assistant',
        model: options.model,
        content: result.text
          ? [{ type: 'text', text: result.text, citations: null }]
          : [],
        stop_reason: stopReason(result),
        stop_sequence: null,
        stop_details: null,
        container: null,
        diagnostics: null,
        usage: anthropicUsage(result.usage),
      });
    },
    startStream() {
      startEventStream(res);
      event('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: options.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          container: null,
          diagnostics: null,
          // Run usage is known only at the end; message_delta carries it.
          usage: anthropicUsage(undefined),
        },
      });
    },
    keepalive() {
      event('ping', { type: 'ping' });
    },
    finishStream(result) {
      if (result.text) {
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        });
        for (const part of chunks(result.text)) {
          event('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: part },
          });
        }
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
      }
      event('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason(result),
          stop_sequence: null,
          stop_details: null,
          container: null,
        },
        usage: anthropicUsage(result.usage),
      });
      event('message_stop', { type: 'message_stop' });
      end(res);
    },
    failStream(error) {
      event('error', anthropicErrorBody(error).body);
      end(res);
    },
  };
}

// ── OpenAI Responses ──────────────────────────────────────────────────

/** Responses has its own envelope and SSE lifecycle (not Chat chunks). */
export function createResponsesResponder(
  res: NextApiResponse,
  options: ResponderOptions,
): CompatResponder {
  const id = `resp_${options.runId}`;
  const itemId = `msg_${options.runId}`;
  const created = options.created ?? Math.floor(Date.now() / 1000);
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>) => {
    write(
      res,
      `event: ${type}\ndata: ${JSON.stringify({
        type,
        sequence_number: sequence++,
        ...data,
      })}\n\n`,
    );
  };
  const content = (text: string) => ({
    type: 'output_text',
    text,
    annotations: [],
    logprobs: [],
  });
  const item = (text: string, status: string) => ({
    id: itemId,
    type: 'message',
    role: 'assistant',
    status,
    content: [content(text)],
  });
  const response = (result?: CompatCompletion, failure?: CompatError) => {
    const usage = result?.usage;
    const completeUsage =
      usage && usage.inputTokens !== null && usage.outputTokens !== null;
    return {
      id,
      object: 'response',
      created_at: created,
      model: options.model,
      access_programs: null,
      status: failure
        ? 'failed'
        : !result
        ? 'in_progress'
        : result.truncated
        ? 'incomplete'
        : 'completed',
      completed_at:
        result && !result.truncated ? Math.floor(Date.now() / 1000) : null,
      error: failure
        ? { code: 'server_error', message: failure.message }
        : null,
      incomplete_details: result?.truncated
        ? { reason: 'max_output_tokens' }
        : null,
      output: result
        ? [item(result.text, result.truncated ? 'incomplete' : 'completed')]
        : [],
      instructions: null,
      metadata: {},
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      max_tool_calls: null,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      text: { format: { type: 'text' } },
      truncation: 'disabled',
      store: false,
      background: false,
      service_tier: 'default',
      user: null,
      safety_identifier: null,
      prompt_cache_key: null,
      usage: completeUsage
        ? {
            input_tokens: usage.inputTokens,
            input_tokens_details: {
              cached_tokens: usage.cachedTokens ?? 0,
              cache_write_tokens: 0,
            },
            output_tokens: usage.outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.inputTokens! + usage.outputTokens!,
          }
        : null,
    };
  };
  return {
    streaming: options.stream,
    sendError(error) {
      const { status, body } = openAIErrorBody(error);
      writeJsonError(res, status, error, body);
    },
    sendCompletion(result) {
      res.setHeader('x-daedalus-usage', usageCompleteness(result.usage));
      res.status(200).json(response(result));
    },
    startStream() {
      startEventStream(res);
      event('response.created', { response: response() });
      event('response.in_progress', { response: response() });
    },
    keepalive() {
      write(res, ': keepalive\n\n');
    },
    finishStream(result) {
      event('response.output_item.added', {
        output_index: 0,
        item: { ...item('', 'in_progress'), content: [] },
      });
      event('response.content_part.added', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: content(''),
      });
      for (const delta of chunks(result.text)) {
        event('response.output_text.delta', {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
        });
      }
      event('response.output_text.done', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: result.text,
        logprobs: [],
      });
      event('response.content_part.done', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: content(result.text),
      });
      event('response.output_item.done', {
        output_index: 0,
        item: item(result.text, result.truncated ? 'incomplete' : 'completed'),
      });
      event(result.truncated ? 'response.incomplete' : 'response.completed', {
        response: response(result),
      });
      end(res);
    },
    failStream(error) {
      event('response.failed', { response: response(undefined, error) });
      event('error', {
        code: error.code ?? 'server_error',
        message: error.message,
        param: error.param ?? null,
        ...(error.details ? { daedalus: errorExtension(error.details) } : {}),
      });
      end(res);
    },
  };
}
