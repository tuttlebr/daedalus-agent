import {
  MilvusCollectionOwnershipError,
  resolveMilvusCollectionTarget,
} from '@/utils/app/milvusCollections';
import { sanitizeForPromptInterpolation } from '@/utils/app/promptSafety';
import { Logger } from '@/utils/logger';

import { canAccessStoredVTT, getVTT } from '@/pages/api/session/vttStorage';

import { ApiRouteError, type DocumentIngestJobRequest } from './types';

import {
  DocumentRefAccessError,
  validateDocumentRefsForUser,
} from '@/server/session/documentRefs';

const logger = new Logger('AsyncJob');

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

export function buildDocumentIngestNatMessages(
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

/**
 * Normalize the inbound messages for the agent: validate document attachments
 * against the caller, inject image/video reference hints, inline VTT/transcript
 * content from Redis, and compact ingestion messages. Pure transform over the
 * message array (no job/Redis state beyond the per-attachment VTT fetch).
 */
export async function processMessages(
  messages: any[],
  currentSessionId: string,
  verifiedUsername: string,
  jobId: string,
): Promise<any[]> {
  return Promise.all(
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
                    logger.info(`Job ${jobId}: Added VTT content to message`, {
                      filename,
                      vttContentLength: storedVtt.data.length,
                      totalContentLength: cleanedMessage.content.length,
                    });
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
                    {
                      vttRef: att.vttRef,
                      error,
                    },
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
}
