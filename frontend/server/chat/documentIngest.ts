import { buildBackendUrlFromBase } from '@/utils/app/backendApi';
import { Logger } from '@/utils/logger';

import { getNatBaseUrl } from './backendSelection';
import { DOCUMENT_INGEST_TIMEOUT_MS } from './constants';
import { finalizeError, finalizeSuccess } from './finalization';
import { clearOAuthStatusFields, updateJobStatus } from './jobState';
import { buildNatRequestHeaders } from './natMessages';
import {
  ApiRouteError,
  type AsyncJobRequest,
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

async function streamDocumentIngestJob(
  jobId: string,
  jobRequest: AsyncJobRequest,
  verifiedUsername: string,
  onProgress: (progress: DocumentIngestProgress) => Promise<void>,
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
  const timeoutId = setTimeout(
    () => controller.abort(),
    DOCUMENT_INGEST_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(ingestUrl, {
      method: 'POST',
      headers: buildNatRequestHeaders(
        verifiedUsername,
        { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        jobRequest.natSessionId,
      ),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new Error(
        `Document ingest timed out after ${DOCUMENT_INGEST_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    const errBody = await response.text().catch(() => '');
    throw new Error(
      `Document ingest failed (${response.status}): ${
        errBody || response.statusText
      }`,
    );
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    throw new Error('Document ingest stream returned no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalOutput: string | null = null;
  let errorDetail: string | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIdx: number;
      while ((separatorIdx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        if (!rawEvent.trim()) continue;

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
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
          finalOutput = typeof parsed.output === 'string' ? parsed.output : '';
        } else if (event === 'error') {
          errorDetail =
            typeof parsed.detail === 'string' ? parsed.detail : 'Unknown error';
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (errorDetail) {
    throw new Error(`Document ingest failed: ${errorDetail}`);
  }
  return finalOutput || 'Document ingestion completed.';
}

export async function startBackgroundDocumentIngest(
  jobId: string,
  jobRequest: AsyncJobRequest,
  verifiedUsername: string,
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
      jobId,
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
    );
    await finalizeSuccess(jobId, jobRequest, output);
  } catch (error: any) {
    logger.error(`Job ${jobId}: Direct document ingest failed`, error);
    await finalizeError(
      jobId,
      jobRequest,
      error?.message || 'Document ingestion failed.',
    );
  }
}
