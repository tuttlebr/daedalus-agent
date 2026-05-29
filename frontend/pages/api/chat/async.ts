import type { NextApiRequest, NextApiResponse } from 'next';

import { buildBackendBaseUrlForMode } from '@/utils/app/backendApi';
import { stripReplayedAssistantPrefix } from '@/utils/app/conversationReplay';
import {
  MilvusCollectionOwnershipError,
  resolveMilvusCollectionTarget,
} from '@/utils/app/milvusCollections';
import { sanitizeForPromptInterpolation } from '@/utils/app/promptSafety';
import { getSession } from '@/utils/auth/session';
import { Logger } from '@/utils/logger';
import { publishStreamingState } from '@/utils/sync/publish';

import { canAccessStoredVTT, getVTT } from '../session/vttStorage';

import {
  fetchNatJobStatus,
  selectStreamBackendBaseUrl,
  submitNatAsyncJob,
} from '@/server/chat/backendSelection';
import { launchBackgroundFinalizer } from '@/server/chat/backgroundFinalizer';
import {
  JOB_EXPIRY_SECONDS,
  STREAM_JOB_STALE_TIMEOUT_MS,
} from '@/server/chat/constants';
import {
  formatIngestPartialResponse,
  startBackgroundDocumentIngest,
} from '@/server/chat/documentIngest';
import {
  finalizeError,
  finalizeFromNatStatus,
} from '@/server/chat/finalization';
import {
  abortKey,
  clearOAuthStatusFields,
  isPlausibleUnixMs,
  isTerminalJobStatus,
  mapNatStatus,
  updateJobStatus,
} from '@/server/chat/jobState';
import {
  buildBoundedMessagesForNat,
  buildNatSessionId,
} from '@/server/chat/natMessages';
import { startBackgroundStreamReader } from '@/server/chat/streamReader';
import {
  ApiRouteError,
  type AsyncJobRequest,
  type AsyncJobStatus,
  type DocumentIngestJobRequest,
  type DocumentIngestProgress,
  type NatAsyncJobResponse,
} from '@/server/chat/types';
import { getOrSetSessionId } from '@/server/session/_utils';
import {
  DocumentRefAccessError,
  validateDocumentRefsForUser,
} from '@/server/session/documentRefs';
import {
  sessionKey,
  jsonGet,
  jsonSetWithExpiry,
  jsonDel,
  setStreamingState,
  clearStreamingState,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

// Re-exported to preserve the historical public surface of this route module
// (the test suite imports these from '@/pages/api/chat/async').
export {
  extractAsyncStreamContentDelta,
  parseIntermediateDataLine,
} from '@/utils/app/asyncStepParser';
export {
  buildBoundedMessagesForNat,
  buildNatRequestHeaders,
  buildNatSessionId,
} from '@/server/chat/natMessages';
export {
  fetchNatJobStatus,
  resolveAsyncBackendBaseUrls,
} from '@/server/chat/backendSelection';

const logger = new Logger('AsyncJob');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '300mb', // Support large document processing payloads
    },
  },
  maxDuration: 900, // 15 minutes
};

function isNatAsyncExecutionMode(
  mode: AsyncJobRequest['executionMode'],
): mode is 'nat_async' {
  return mode === 'nat_async' || mode === undefined;
}

function isDirectDocumentIngestStreamEnabled(): boolean {
  return process.env.DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM !== '0';
}

function resolveDocumentCollectionTarget(
  options: Parameters<typeof resolveMilvusCollectionTarget>[0],
) {
  try {
    return resolveMilvusCollectionTarget(options);
  } catch (error) {
    // Cross-tenant collection targeting is an authorization failure (403),
    // distinct from a scope-label mismatch (400). See F-001.
    if (error instanceof MilvusCollectionOwnershipError) {
      throw new ApiRouteError(
        403,
        'You do not have access to the target collection.',
        'collection_forbidden',
      );
    }
    const message =
      error instanceof Error
        ? error.message
        : 'Invalid document collection target.';
    throw new ApiRouteError(400, message, 'collection_scope_mismatch');
  }
}

function collectDocumentRefs(attachments: any[]): any[] {
  const refs: any[] = [];
  for (const attachment of attachments) {
    if (attachment?.type !== 'document' || !attachment.documentRef) continue;
    refs.push({
      ...attachment.documentRef,
      filename: attachment.content || attachment.documentRef.filename,
    });
  }
  return refs;
}

function stripClientDocumentRefHints(content: string): string {
  if (!content) return '';

  return content
    .replace(
      /\n?\*\*Document References? for Tools:\*\*\nUse this documentRefs? parameter: documentRefs?=[\s\S]*?(?=\n\n|\n\*\*|$)/gi,
      '',
    )
    .replace(/\n?\[DOCUMENT_REFERENCE_\d+\]:\s*\{[^\n]*\}/gi, '')
    .replace(/\n?Document \d+:\s*\{[^\n]*\}/gi, '')
    .trimEnd();
}

async function validateDocumentAttachmentsForMessage(
  message: any,
  currentSessionId: string,
  verifiedUsername: string,
): Promise<any> {
  if (!message.attachments || !Array.isArray(message.attachments)) {
    return message;
  }

  const validatedAttachments = [];
  for (const attachment of message.attachments) {
    if (attachment?.type !== 'document' || !attachment.documentRef) {
      validatedAttachments.push(attachment);
      continue;
    }

    try {
      const [validatedRef] = await validateDocumentRefsForUser(
        [
          {
            ...attachment.documentRef,
            filename: attachment.content || attachment.documentRef.filename,
          },
        ],
        currentSessionId,
        verifiedUsername,
      );
      validatedAttachments.push({
        ...attachment,
        documentRef: validatedRef,
      });
    } catch (error) {
      if (error instanceof DocumentRefAccessError) {
        throw new ApiRouteError(error.status, error.message, error.reason);
      }
      throw error;
    }
  }

  return {
    ...message,
    attachments: validatedAttachments,
  };
}

// Inline mode: the client extracted the doc to markdown and embedded it
// directly in the user message between <attached_document> tags. We must NOT
// route these messages through the ingest tool — they're regular streaming
// chat with the doc text already in the prompt.
const INLINE_DOCUMENT_MARKER = /<attached_document\b/i;

function hasInlineDocumentMarker(message: any): boolean {
  const content = typeof message?.content === 'string' ? message.content : '';
  return INLINE_DOCUMENT_MARKER.test(content);
}

export function appendDocumentAttachmentContext(
  message: any,
  verifiedUsername: string,
): any {
  if (!message.attachments || !Array.isArray(message.attachments)) {
    return message;
  }

  // Inline mode embeds the doc markdown directly — don't add a routing hint
  // that would make the agent try to ingest the (already-handled) document.
  if (hasInlineDocumentMarker(message)) {
    return message;
  }

  const documentRefs = collectDocumentRefs(message.attachments);
  if (documentRefs.length === 0) {
    return message;
  }

  const content = stripClientDocumentRefHints(
    typeof message.content === 'string' ? message.content : '',
  );

  const targetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim()
      ? message.metadata.targetCollection.trim()
      : undefined;
  const collectionTarget = targetCollection
    ? resolveDocumentCollectionTarget({
        targetCollection,
        username: verifiedUsername,
        requestedScope: message.metadata?.collectionScope,
        source: 'chat.attachment_context',
      })
    : undefined;

  const refArg =
    documentRefs.length === 1
      ? `documentRef=${JSON.stringify(documentRefs[0])}`
      : `documentRefs=${JSON.stringify(documentRefs)}`;
  const collectionArg = collectionTarget
    ? `, collection_name="${collectionTarget.collectionName}", ` +
      `collection_scope="${collectionTarget.collectionScope}"`
    : '';
  const noun = documentRefs.length === 1 ? 'document' : 'documents';

  const documentContext =
    `\n\n[User has attached ${documentRefs.length} ${noun}. ` +
    `For ingestion, call user_document_tool with operation="ingest", ` +
    `${refArg}, username="${verifiedUsername}"${collectionArg}.]`;

  return {
    ...message,
    content: `${content}${documentContext}`,
  };
}

function isDocumentIngestionMessage(message: any): boolean {
  // Inline mode is the opposite of ingestion: the doc is already in the
  // message body, no Milvus write should happen.
  if (hasInlineDocumentMarker(message)) return false;

  const documentRefs = collectDocumentRefs(message.attachments || []);
  if (documentRefs.length === 0) return false;

  const content = typeof message.content === 'string' ? message.content : '';
  const hasTargetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim();

  return Boolean(
    hasTargetCollection ||
      /\b(ingest|index|knowledge base|collection)\b/i.test(content),
  );
}

// The user's just-submitted message is always the last user-role entry in the
// payload. Earlier user messages can still carry document attachments + ingest
// metadata from prior turns, so scanning the full history would re-route plain
// follow-up questions through the ingestion path.
function getLastUserMessage(messages: any[]): any | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}

export function isDocumentIngestionRequest(messages: any[]): boolean {
  const lastUserMessage = getLastUserMessage(messages);
  return Boolean(
    lastUserMessage && isDocumentIngestionMessage(lastUserMessage),
  );
}

export function compactDocumentIngestionMessage(
  message: any,
  _verifiedUsername: string,
): any {
  if (!isDocumentIngestionMessage(message)) {
    return message;
  }

  const documentRefs = collectDocumentRefs(message.attachments || []);
  const targetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim()
      ? message.metadata.targetCollection.trim()
      : undefined;
  const noun = documentRefs.length === 1 ? 'document' : 'documents';
  const targetText = targetCollection
    ? ` into the "${targetCollection}" collection`
    : '';

  return {
    ...message,
    content: `Ingest ${documentRefs.length} uploaded ${noun}${targetText}.`,
  };
}

export function getDocumentIngestJobRequest(
  messages: any[],
  verifiedUsername: string,
): DocumentIngestJobRequest | null {
  const message = getLastUserMessage(messages);
  if (!message || !isDocumentIngestionMessage(message)) return null;

  const documentRefs = collectDocumentRefs(message.attachments || []);
  if (documentRefs.length === 0) return null;

  const targetCollection =
    typeof message.metadata?.targetCollection === 'string' &&
    message.metadata.targetCollection.trim()
      ? message.metadata.targetCollection.trim()
      : verifiedUsername;
  const collectionTarget = resolveDocumentCollectionTarget({
    targetCollection,
    username: verifiedUsername,
    requestedScope: message.metadata?.collectionScope,
    source: 'chat.async_document_ingest',
  });

  return {
    documentRefs,
    collectionName: collectionTarget.collectionName,
    collectionScope: collectionTarget.collectionScope,
    provenance: collectionTarget.provenance,
    username: verifiedUsername,
  };
}

function buildDocumentIngestNatMessages(
  documentIngest: DocumentIngestJobRequest,
): any[] {
  const refArg =
    documentIngest.documentRefs.length === 1
      ? `documentRef=${JSON.stringify(documentIngest.documentRefs[0])}`
      : `documentRefs=${JSON.stringify(documentIngest.documentRefs)}`;
  const noun =
    documentIngest.documentRefs.length === 1 ? 'document' : 'documents';

  return [
    {
      role: 'user',
      content:
        `Process ${documentIngest.documentRefs.length} uploaded ${noun} ` +
        `using user_document_tool with operation="ingest", ${refArg}, ` +
        `username="${documentIngest.username}", and ` +
        `collection_name="${documentIngest.collectionName}", ` +
        `collection_scope="${documentIngest.collectionScope}", and ` +
        `provenance=${JSON.stringify(documentIngest.provenance)}.`,
    },
  ];
}

async function sanitizeJobStatusForReturn(
  jobId: string,
  status: AsyncJobStatus,
  jobRequest: AsyncJobRequest,
): Promise<AsyncJobStatus> {
  const updates: Partial<AsyncJobStatus> = {};

  if (
    status.status !== 'oauth_required' &&
    (status.authUrl || status.oauthState)
  ) {
    Object.assign(updates, clearOAuthStatusFields());
  }

  if (typeof status.fullResponse === 'string' && status.fullResponse) {
    const fullResponse = stripReplayedAssistantPrefix(
      status.fullResponse,
      jobRequest.messages || [],
    );
    if (fullResponse !== status.fullResponse) {
      updates.fullResponse = fullResponse;
    }
  }

  if (typeof status.partialResponse === 'string' && status.partialResponse) {
    const partialResponse = stripReplayedAssistantPrefix(
      status.partialResponse,
      jobRequest.messages || [],
    );
    if (partialResponse !== status.partialResponse) {
      updates.partialResponse = partialResponse;
    }
  }

  if (Object.keys(updates).length === 0) {
    return status;
  }

  const sanitized = {
    ...status,
    ...updates,
    updatedAt: Date.now(),
  };
  await updateJobStatus(jobId, {
    ...updates,
    updatedAt: sanitized.updatedAt,
  }).catch((error) => {
    logger.warn(`Job ${jobId}: Failed to persist sanitized response`, error);
  });
  return sanitized;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === 'POST') {
    return handlePost(req, res);
  } else if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'DELETE') {
    return handleDelete(req, res);
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── POST: Submit a new async job to NAT ──────────────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    const {
      messages,
      additionalProps,
      conversationId,
      conversationName,
      turnId,
      assistantMessageId,
    } = req.body;

    // SECURITY: Derive user identity from the server-side session,
    // not from client-sent identity fields which can be spoofed.
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const verifiedUsername = session.username;
    const currentSessionId = getOrSetSessionId(req, res);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    // Overwrite client-sent identity fields with verified values
    if (additionalProps) {
      additionalProps.username = verifiedUsername;
      if (additionalProps.userContext) {
        additionalProps.userContext.username = verifiedUsername;
        additionalProps.userContext.id = session?.userId || null;
        additionalProps.userContext.name = session?.name || null;
      }
    }

    const jobId = uuidv4();
    const natSessionId = buildNatSessionId(
      verifiedUsername,
      jobId,
      typeof conversationId === 'string' ? conversationId : undefined,
      typeof turnId === 'string' ? turnId : undefined,
    );

    // Process messages: add attachment references/content for agent context
    const processedMessages = await Promise.all(
      (messages || []).map(async (message: any) => {
        let cleanedMessage = { ...message };

        if (
          cleanedMessage.attachments &&
          Array.isArray(cleanedMessage.attachments)
        ) {
          cleanedMessage = await validateDocumentAttachmentsForMessage(
            cleanedMessage,
            currentSessionId,
            verifiedUsername,
          );

          // Image references
          const imageAttachments = cleanedMessage.attachments.filter(
            (att: any) => att.type === 'image',
          );
          if (imageAttachments.length > 0) {
            // Skip if cleanMessagesForLLM already injected references
            const alreadyHasImageRefs =
              cleanedMessage.content?.includes('[IMAGE_REFERENCE_');
            if (!alreadyHasImageRefs) {
              const allImageRefs: any[] = [];
              imageAttachments.forEach((att: any) => {
                if (att.imageRef) {
                  allImageRefs.push(att.imageRef);
                } else if (att.imageRefs && Array.isArray(att.imageRefs)) {
                  allImageRefs.push(...att.imageRefs);
                }
              });

              if (allImageRefs.length > 0) {
                let imageRefContext = '\n\n[User has attached ';
                if (allImageRefs.length === 1) {
                  imageRefContext += `1 image. To use this image with tools, pass imageRef=${JSON.stringify(
                    allImageRefs[0],
                  )}]`;
                } else {
                  imageRefContext += `${
                    allImageRefs.length
                  } images. To use these images with tools, pass imageRef=${JSON.stringify(
                    allImageRefs,
                  )}]`;
                }
                cleanedMessage.content =
                  (cleanedMessage.content || '') + imageRefContext;
              }
            }
          }

          // Video references
          const videoAttachments = cleanedMessage.attachments.filter(
            (att: any) => att.type === 'video',
          );
          if (videoAttachments.length > 0) {
            const alreadyHasVideoRefs =
              cleanedMessage.content?.includes('[VIDEO_REFERENCE_');
            if (!alreadyHasVideoRefs) {
              const allVideoRefs: any[] = [];
              videoAttachments.forEach((att: any) => {
                if (att.videoRef) {
                  allVideoRefs.push(att.videoRef);
                } else if (att.videoRefs && Array.isArray(att.videoRefs)) {
                  allVideoRefs.push(...att.videoRefs);
                }
              });

              if (allVideoRefs.length > 0) {
                let videoRefContext = '\n\n[User has attached ';
                if (allVideoRefs.length === 1) {
                  videoRefContext += `1 video. To use this video with tools, pass videoRef=${JSON.stringify(
                    allVideoRefs[0],
                  )}]`;
                } else {
                  videoRefContext += `${
                    allVideoRefs.length
                  } videos. To use these videos with tools, pass videoRef=${JSON.stringify(
                    allVideoRefs,
                  )}]`;
                }
                cleanedMessage.content =
                  (cleanedMessage.content || '') + videoRefContext;
              }
            }
          }

          // VTT/transcript content — retrieve from Redis and inject into message
          const vttAttachments = cleanedMessage.attachments.filter(
            (att: any) => att.type === 'transcript',
          );
          if (vttAttachments.length > 0) {
            const alreadyHasVttContent = cleanedMessage.content?.includes(
              '<transcript filename=',
            );
            if (!alreadyHasVttContent) {
              for (const att of vttAttachments) {
                if (att.vttRef?.vttId && att.vttRef?.sessionId) {
                  try {
                    const storedVtt = await getVTT(
                      att.vttRef.sessionId,
                      att.vttRef.vttId,
                    );
                    if (!storedVtt) {
                      throw new ApiRouteError(
                        404,
                        'Transcript attachment not found. Please upload it again.',
                        'attachment_not_found',
                      );
                    }
                    if (
                      !canAccessStoredVTT(
                        storedVtt,
                        currentSessionId,
                        verifiedUsername,
                      )
                    ) {
                      throw new ApiRouteError(
                        403,
                        'You do not have access to one of the transcript attachments.',
                        'attachment_forbidden',
                      );
                    }
                    if (storedVtt?.data) {
                      // Untrusted filename embedded in an agent instruction
                      // and a <transcript> tag attribute — defang it (F-008).
                      const filename =
                        sanitizeForPromptInterpolation(
                          att.vttRef.filename || storedVtt.filename,
                        ) || 'transcript';
                      let vttContext = `\n\n[User has attached a VTT/SRT transcript file "${filename}". `;
                      vttContext += `Use the vtt_interpreter_tool to process this transcript. `;
                      vttContext += `Pass the transcript content below as the transcript_text parameter. `;
                      vttContext += `If the user's message contains specific instructions (e.g. "list action items", "what did X say about Y"), pass those as the user_instructions parameter.]\n\n`;
                      vttContext += `<transcript filename="${filename}">\n${storedVtt.data}\n</transcript>`;
                      cleanedMessage.content =
                        (cleanedMessage.content || '') + vttContext;
                      logger.info(
                        `Job ${jobId}: Added VTT content to message`,
                        {
                          filename,
                          vttContentLength: storedVtt.data.length,
                          totalContentLength: cleanedMessage.content.length,
                        },
                      );
                    } else {
                      throw new ApiRouteError(
                        400,
                        'Transcript attachment is empty. Please upload it again.',
                        'attachment_empty',
                      );
                    }
                  } catch (error) {
                    if (error instanceof ApiRouteError) throw error;
                    logger.error(
                      `Job ${jobId}: Error retrieving VTT from Redis`,
                      { vttRef: att.vttRef, error },
                    );
                    throw new ApiRouteError(
                      500,
                      'Failed to read transcript attachment. Please try again.',
                      'attachment_read_failed',
                    );
                  }
                }
              }
            }
          }
        }

        cleanedMessage = compactDocumentIngestionMessage(
          appendDocumentAttachmentContext(cleanedMessage, verifiedUsername),
          verifiedUsername,
        );

        return cleanedMessage;
      }),
    );

    const documentIngest = getDocumentIngestJobRequest(
      processedMessages,
      verifiedUsername,
    );
    const useDirectDocumentIngest = Boolean(
      documentIngest && isDirectDocumentIngestStreamEnabled(),
    );
    const useNatAsyncJob = Boolean(documentIngest && !useDirectDocumentIngest);
    const executionMode: NonNullable<AsyncJobRequest['executionMode']> =
      useDirectDocumentIngest
        ? 'document_ingest'
        : useNatAsyncJob
        ? 'nat_async'
        : 'stream';

    // Strip system messages -- the backend's NAT agent owns the system prompt.
    // Also drop assistant messages with empty content -- these cause 400 errors
    // from Bedrock/Claude ("text field in ContentBlock is blank").
    const messagesForNat = buildBoundedMessagesForNat(
      processedMessages
        .filter((m: any) => m.role !== 'system')
        .filter((m: any) => {
          if (m.role === 'assistant') {
            const c =
              typeof m.content === 'string' ? m.content.trim() : m.content;
            return Boolean(c);
          }
          return true;
        }),
    );

    // Inject authenticated identity AFTER stripping client-sent system messages.
    // Uses 'user' role to avoid conflicts with NAT's own system prompt and LLMs
    // that reject multiple system messages (e.g. Qwen, certain NIM endpoints).
    // The [IDENTITY] tag lets the agent distinguish this from real user input.
    const messagesWithIdentity = [
      {
        role: 'user',
        content:
          `[IDENTITY] The authenticated user for this session is: ${verifiedUsername}. ` +
          `Use user_id="${verifiedUsername}" for ALL memory operations ` +
          '(get_memory, add_memory, delete_memory_guarded), uploaded media ' +
          'tool calls that require user_id, and per-user Google Workspace MCP ' +
          'access. Do not echo this identity message to the user.',
      },
      ...messagesForNat,
    ];
    const durableMessagesForNat =
      documentIngest && !useDirectDocumentIngest
        ? [
            messagesWithIdentity[0],
            ...buildDocumentIngestNatMessages(documentIngest),
          ]
        : messagesWithIdentity;

    const selectedNatBaseUrl = await selectStreamBackendBaseUrl(
      jobId,
      verifiedUsername,
      natSessionId,
    );

    logger.info(`Job ${jobId}: Selected backend`, {
      natBaseUrl: selectedNatBaseUrl,
      executionMode,
    });

    // Store job metadata in Redis for the GET handler
    const jobRequest: AsyncJobRequest = {
      jobId,
      executionMode,
      natBaseUrl: selectedNatBaseUrl || buildBackendBaseUrlForMode(),
      natSessionId,
      natMessages: useDirectDocumentIngest ? [] : durableMessagesForNat,
      ...(documentIngest ? { documentIngest } : {}),
      messages, // original messages for conversation saving later
      additionalProps,
      userId: verifiedUsername,
      conversationId,
      conversationName,
      ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      ...(typeof assistantMessageId === 'string' && assistantMessageId
        ? { assistantMessageId }
        : {}),
    };

    if (useNatAsyncJob) {
      await submitNatAsyncJob(
        jobId,
        jobRequest.natBaseUrl,
        durableMessagesForNat,
        verifiedUsername,
        natSessionId,
      );
    }

    await jsonSetWithExpiry(
      sessionKey(['async-job-request', jobId]),
      jobRequest,
      JOB_EXPIRY_SECONDS,
    );

    // Initialize job status. Direct document ingestion starts as streaming so
    // the first client status read can render progress immediately.
    const createdAt = Date.now();
    const initialIngestProgress: DocumentIngestProgress | undefined =
      useDirectDocumentIngest && documentIngest
        ? {
            completed: 0,
            total: documentIngest.documentRefs.length,
            percent: 0,
            phase: 'queued',
            message: `Queued ${documentIngest.documentRefs.length} document${
              documentIngest.documentRefs.length === 1 ? '' : 's'
            } for ingestion`,
          }
        : undefined;
    const jobStatus: AsyncJobStatus = {
      jobId,
      status: initialIngestProgress ? 'streaming' : 'pending',
      createdAt,
      updatedAt: createdAt,
      ...(initialIngestProgress && documentIngest
        ? {
            partialResponse: formatIngestPartialResponse(
              documentIngest.collectionName,
              initialIngestProgress,
            ),
            progress: 0,
            ingestProgress: initialIngestProgress,
          }
        : {}),
      conversationId,
      ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      ...(typeof assistantMessageId === 'string' && assistantMessageId
        ? { assistantMessageId }
        : {}),
    };
    await jsonSetWithExpiry(
      sessionKey(['async-job-status', jobId]),
      jobStatus,
      JOB_EXPIRY_SECONDS,
    );

    if (useDirectDocumentIngest) {
      const effectiveUserId = verifiedUsername;
      if (conversationId) {
        await setStreamingState(effectiveUserId, conversationId, jobId);
        await publishStreamingState(
          effectiveUserId,
          conversationId,
          true,
          jobId,
        );
      }

      res.status(200).json({ jobId, status: jobStatus.status });
      startBackgroundDocumentIngest(jobId, jobRequest, verifiedUsername).catch(
        (err) => {
          logger.error(`Job ${jobId}: Background document ingest failed`, err);
        },
      );
      return;
    }

    // Set streaming state for cross-session UI
    const effectiveUserId = verifiedUsername;
    if (conversationId) {
      await setStreamingState(effectiveUserId, conversationId, jobId);
      await publishStreamingState(effectiveUserId, conversationId, true, jobId);
    }

    // Respond immediately so the client can start polling / WS listening
    res.status(200).json({ jobId, status: jobStatus.status });

    if (!useNatAsyncJob) {
      startBackgroundStreamReader(
        jobId,
        jobRequest,
        durableMessagesForNat,
        verifiedUsername,
      ).catch((err) => {
        logger.error(`Job ${jobId}: Background stream reader failed`, err);
      });
    }

    return;
  } catch (error) {
    if (error instanceof ApiRouteError) {
      logger.warn(`Rejected async job request: ${error.message}`, {
        status: error.status,
        reason: error.reason,
      });
      return res.status(error.status).json({
        error: error.message,
        reason: error.reason,
      });
    }
    logger.error('Error creating async job', error);
    return res.status(500).json({ error: 'Failed to create job' });
  }
}

// ── GET: Poll job status from NAT, finalize on completion ────────────

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { jobId } = req.query;

  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  try {
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const statusKey = sessionKey(['async-job-status', jobId]);
    const jobStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;

    if (!jobStatus) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobRequest = (await jsonGet(
      sessionKey(['async-job-request', jobId]),
    )) as AsyncJobRequest | null;
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // If already finalized, return cached status immediately
    if (
      (jobStatus.status === 'completed' || jobStatus.status === 'error') &&
      jobStatus.finalizedAt
    ) {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (jobRequest.executionMode === 'stream') {
      const lastActivityAt = jobStatus.updatedAt || jobStatus.createdAt;
      if (
        !isTerminalJobStatus(jobStatus.status) &&
        isPlausibleUnixMs(lastActivityAt) &&
        Date.now() - lastActivityAt > STREAM_JOB_STALE_TIMEOUT_MS
      ) {
        await finalizeError(
          jobId,
          jobRequest,
          'Backend stream did not produce an update before the timeout. Please try again.',
        );
        const updated =
          ((await jsonGet(statusKey)) as AsyncJobStatus | null) || jobStatus;
        const sanitized = await sanitizeJobStatusForReturn(
          jobId,
          updated,
          jobRequest,
        );
        return res.status(200).json(sanitized);
      }
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (jobRequest.executionMode === 'document_ingest') {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (!isNatAsyncExecutionMode(jobRequest.executionMode)) {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    // Fetch live status from NAT for legacy durable async jobs.
    launchBackgroundFinalizer(jobId, jobRequest);

    let natStatus: NatAsyncJobResponse | null = null;

    try {
      natStatus = await fetchNatJobStatus(jobId, jobRequest);
    } catch (err) {
      logger.error(`Job ${jobId}: Failed to fetch NAT status`, err);
      // Return cached status on transient error -- polling will retry
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    if (!natStatus) {
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    const mappedStatus = mapNatStatus(natStatus.status);

    // Merge live intermediate steps from the background stream reader
    const stepsKey = sessionKey(['async-job-steps', jobId]);
    const liveSteps = (await jsonGet(stepsKey)) as any[] | null;

    // Still in progress
    if (mappedStatus === 'pending' || mappedStatus === 'streaming') {
      await updateJobStatus(jobId, {
        status: mappedStatus,
        progress: mappedStatus === 'streaming' ? 50 : 0,
        ...clearOAuthStatusFields(),
        ...(liveSteps?.length ? { intermediateSteps: liveSteps } : {}),
        updatedAt: Date.now(),
      });
      const updated =
        ((await jsonGet(statusKey)) as AsyncJobStatus | null) || jobStatus;
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        updated,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    // Failed or expired
    if (mappedStatus === 'error') {
      const updated = await finalizeFromNatStatus(jobId, jobRequest, natStatus);
      const sanitized = await sanitizeJobStatusForReturn(
        jobId,
        updated || jobStatus,
        jobRequest,
      );
      return res.status(200).json(sanitized);
    }

    const finalStatus = await finalizeFromNatStatus(
      jobId,
      jobRequest,
      natStatus,
    );
    const sanitized = await sanitizeJobStatusForReturn(
      jobId,
      finalStatus || jobStatus,
      jobRequest,
    );
    return res.status(200).json(sanitized);
  } catch (error) {
    logger.error('Error fetching job status', error);
    return res.status(500).json({ error: 'Failed to fetch job status' });
  }
}

// ── DELETE: Cancel job ───────────────────────────────────────────────

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const { jobId } = req.query;

  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  try {
    const session = await getSession(req, res);
    if (!session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const requestKey = sessionKey(['async-job-request', jobId]);
    const statusKey = sessionKey(['async-job-status', jobId]);
    const stepsKey = sessionKey(['async-job-steps', jobId]);
    const jobRequest = (await jsonGet(requestKey)) as AsyncJobRequest | null;
    if (!jobRequest || jobRequest.userId !== session.username) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;

    await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS).catch(
      () => {},
    );

    // Clear streaming state if we have context
    if (jobRequest?.conversationId && jobRequest?.userId) {
      await clearStreamingState(
        jobRequest.userId,
        jobRequest.conversationId,
      ).catch(() => {});
      await publishStreamingState(
        jobRequest.userId,
        jobRequest.conversationId,
        false,
        jobId as string,
      ).catch(() => {});
    }

    if (currentStatus && !currentStatus.finalizedAt) {
      const streamSteps = (await jsonGet(stepsKey)) as any[] | null;
      const partialResponse = stripReplayedAssistantPrefix(
        currentStatus.partialResponse || '',
        jobRequest.messages || [],
      );
      await updateJobStatus(jobId, {
        status: 'error',
        error: 'Job canceled by user',
        partialResponse,
        ...clearOAuthStatusFields(),
        intermediateSteps: streamSteps?.length
          ? streamSteps
          : currentStatus.intermediateSteps || [],
        updatedAt: Date.now(),
        finalizedAt: Date.now(),
      });
    }

    await Promise.all([jsonDel(requestKey), jsonDel(stepsKey)]);

    // NOTE: NAT async does not expose a cancel endpoint. The backend run (an
    // asyncio task) continues to completion; we mark the job canceled in Redis
    // and set the abort flag so the stream reader stops publishing.
    // NAT's expiry_seconds ensures backend cleanup.

    return res.status(200).json({ success: true, canceled: true });
  } catch (error) {
    logger.error('Error canceling job', error);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
}
