import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { Logger } from '@/utils/logger';

import { getNatBaseUrl } from './backendSelection';
import { DOCUMENT_INGEST_TIMEOUT_MS } from './constants';
import { finalizeError, finalizeSuccess } from './finalization';
import { clearOAuthStatusFields, updateJobStatus } from './jobState';
import { buildNatRequestHeaders } from './natMessages';
import {
  ApiRouteError,
  PublicJobError,
  type AsyncJobRequest,
  type BackgroundExecutionControl,
  type DocumentIngestProgress,
} from './types';

const logger = new Logger('AsyncJob');

export function formatIngestPartialResponse(
  collectionName: string,
  ingestProgress: DocumentIngestProgress,
): string {
  const { completed, total, currentDoc, currentIndex, message, phase } =
    ingestProgress;
  if (message) {
    return `${message} (${completed}/${total} into "${collectionName}").`;
  }
  if (completed >= total && total > 0) {
    return `Finalizing ingestion into "${collectionName}".`;
  }
  if (phase === 'fetching') {
    return `Fetching ${
      currentDoc || 'document'
    } for ingestion into "${collectionName}".`;
  }
  if (phase === 'indexing') {
    return `Writing ${currentDoc || 'document'} chunks to "${collectionName}".`;
  }
  if (currentDoc) {
    const indexText = currentIndex
      ? `document ${currentIndex} of ${total}`
      : `${completed} of ${total}`;
    return `Ingesting ${indexText} into "${collectionName}" (${currentDoc}).`;
  }
  return `Ingesting ${total} document${
    total === 1 ? '' : 's'
  } into "${collectionName}".`;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// The backend's terminal ingestion error (builder/runtime/src/document_processor.rs
// FAILED). Other error text can carry storage or service diagnostics.
const PUBLIC_INGEST_ERRORS = new Set(['Document operation failed.']);
const INGEST_INTERNAL_FAILURE_MESSAGE =
  'Document ingestion failed because of an internal error. Please try again.';

/**
 * Saved explanation for a rejected ingestion request. Like chat, it is derived
 * from the status alone; the body is cancelled unread so a stalled diagnostic
 * cannot hold the worker slot or reach the saved chat.
 */
export function documentIngestRejectionMessage(status: number): string {
  if (status === 413) {
    return 'Too many documents were sent at once. Upload them in smaller batches.';
  }
  if (status === 400 || status === 403 || status === 422) {
    return `Document ingestion rejected the request (${status}).`;
  }
  return `Document ingestion is unavailable (${status}). Please try again.`;
}

async function streamDocumentIngestJob(
  jobRequest: AsyncJobRequest,
  verifiedUsername: string,
  onProgress: (progress: DocumentIngestProgress) => Promise<void>,
  control: BackgroundExecutionControl,
): Promise<string> {
  if (!jobRequest.documentIngest) {
    throw new ApiRouteError(
      500,
      'Document ingest job is missing document references.',
      'document_ingest_missing_payload',
    );
  }

  const ingestUrl = buildBackendUrlFromBase(
    getNatBaseUrl(jobRequest),
    '/v1/documents/ingest/stream',
  );
  const payload = {
    documentRefs: jobRequest.documentIngest.documentRefs,
    username: jobRequest.documentIngest.username,
    collection_name: jobRequest.documentIngest.collectionName,
    collection_scope: jobRequest.documentIngest.collectionScope,
    provenance: jobRequest.documentIngest.provenance,
  };

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DOCUMENT_INGEST_TIMEOUT_MS);
  const handleExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(control.signal?.reason);
    }
  };
  if (control.signal) {
    if (control.signal.aborted) {
      handleExternalAbort();
    } else {
      control.signal.addEventListener('abort', handleExternalAbort, {
        once: true,
      });
    }
  }

  let response: Response;
  try {
    await control.beforeBackendRequest?.();
    response = await fetch(ingestUrl, {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        jobRequest.natSessionId,
        jobRequest.timezone,
      ),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    control.signal?.removeEventListener('abort', handleExternalAbort);
    if (control.signal?.aborted) {
      throw control.signal.reason instanceof Error
        ? control.signal.reason
        : err;
    }
    if (timedOut || err?.name === 'AbortError') {
      throw new PublicJobError(
        `Document ingest timed out after ${DOCUMENT_INGEST_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    control.signal?.removeEventListener('abort', handleExternalAbort);
    await response.body?.cancel().catch(() => {});
    logger.warn(`Document ingest request rejected`, {
      status: response.status,
    });
    throw new PublicJobError(documentIngestRejectionMessage(response.status));
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    control.signal?.removeEventListener('abort', handleExternalAbort);
    throw new PublicJobError('Document ingest stream returned no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalOutput: string | null = null;
  let errorDetail: string | null = null;
  let completed = false;
  let reachedEnd = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separator: RegExpExecArray | null;
      while (
        (separator = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(
          buffer,
        )) !== null
      ) {
        const rawEvent = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (!rawEvent.trim()) continue;

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r\n|\r|\n/)) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }
        const dataStr = dataLines.join('\n');
        if (!dataStr) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (event === 'progress') {
          await onProgress({
            completed: Number(parsed.completed) || 0,
            total: Number(parsed.total) || 0,
            currentDoc:
              typeof parsed.current === 'string' ? parsed.current : undefined,
            currentIndex: optionalNumber(parsed.currentIndex),
            percent: Number(parsed.percent) || 0,
            phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
            message:
              typeof parsed.message === 'string' ? parsed.message : undefined,
            chunks: optionalNumber(parsed.chunks),
            pages: optionalNumber(parsed.pages),
            failures: optionalNumber(parsed.failures),
            attempt: optionalNumber(parsed.attempt),
          });
        } else if (event === 'complete') {
          completed = true;
          finalOutput = typeof parsed.output === 'string' ? parsed.output : '';
        } else if (event === 'error') {
          errorDetail =
            typeof parsed.detail === 'string' ? parsed.detail : 'Unknown error';
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
    control.signal?.removeEventListener('abort', handleExternalAbort);
    // A local failure (for example a progress write) ends this job. Close the
    // response so the backend stops queued work instead of ingesting into an
    // orphaned connection that no one reads.
    if (!reachedEnd) await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (errorDetail !== null) {
    if (PUBLIC_INGEST_ERRORS.has(errorDetail)) {
      throw new PublicJobError(`Document ingest failed: ${errorDetail}`);
    }
    logger.error('Document ingest stream reported an error', {
      detail: errorDetail.slice(0, 2000),
    });
    throw new PublicJobError('Document ingestion failed.');
  }
  if (!completed) {
    throw new PublicJobError(
      'Document ingest stream ended before completion was confirmed.',
    );
  }
  return finalOutput || 'Document ingestion completed.';
}

export async function startBackgroundDocumentIngest(
  jobId: string,
  jobRequest: AsyncJobRequest,
  verifiedUsername: string,
  control: BackgroundExecutionControl = {},
): Promise<void> {
  const documentCount = jobRequest.documentIngest?.documentRefs.length || 0;
  const collectionName =
    jobRequest.documentIngest?.collectionName || verifiedUsername;

  const initialIngestProgress: DocumentIngestProgress = {
    completed: 0,
    total: documentCount,
    percent: 0,
    phase: 'queued',
    message: `Queued ${documentCount} document${
      documentCount === 1 ? '' : 's'
    } for ingestion`,
  };

  await updateJobStatus(jobId, {
    status: 'streaming',
    partialResponse: formatIngestPartialResponse(
      collectionName,
      initialIngestProgress,
    ),
    progress: 0,
    ingestProgress: initialIngestProgress,
    ...clearOAuthStatusFields(),
    updatedAt: Date.now(),
  });

  try {
    const output = await streamDocumentIngestJob(
      jobRequest,
      verifiedUsername,
      async (progress) => {
        await updateJobStatus(jobId, {
          status: 'streaming',
          progress: progress.percent,
          ingestProgress: progress,
          partialResponse: formatIngestPartialResponse(
            collectionName,
            progress,
          ),
          updatedAt: Date.now(),
        });
      },
      control,
    );
    await finalizeSuccess(jobId, jobRequest, output);
  } catch (error: any) {
    if (control.signal?.aborted) throw error;
    logger.error(`Job ${jobId}: Direct document ingest failed`, error);
    await finalizeError(
      jobId,
      jobRequest,
      error instanceof PublicJobError || error instanceof ApiRouteError
        ? error.message
        : INGEST_INTERNAL_FAILURE_MESSAGE,
    );
  }
}
