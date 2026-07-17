'use client';

import {
  IconSend,
  IconSquare,
  IconPaperclip,
  IconX,
  IconPhoto,
  IconFileText,
  IconFileDownload,
  IconDatabase,
  IconNotes,
  IconRefresh,
} from '@tabler/icons-react';
import React, { memo, useState, useRef, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';

import { useIsMobile } from '@/hooks/useMediaQuery';

import { uploadDocument } from '@/utils/app/documentHandler';
import { uploadImage } from '@/utils/app/imageHandler';
import { useMilvusCollections } from '@/utils/app/queries';
import { admitUploadBatch } from '@/utils/app/uploadBatch';
import { uploadVideo, getVideoMimeType } from '@/utils/app/videoHandler';
import { uploadVTTFile, isVTTFile } from '@/utils/app/vttHandler';

import { Message } from '@/types/chat';

import { IconButton } from '@/components/primitives';
import { Textarea } from '@/components/primitives';
import { DropZone } from '@/components/primitives';
import { ProgressBar } from '@/components/primitives';
import { GlassToolbar } from '@/components/surfaces';

import { UPLOAD_LIMITS, validateFileSize } from '@/constants/uploadLimits';
import classNames from 'classnames';

type Attachment = NonNullable<Message['attachments']>[number];

interface UploadingFile {
  id: string;
  file: File;
  type: 'image' | 'document' | 'video' | 'transcript';
  progress: number;
  error?: string;
}

interface PendingUpload {
  id: string;
  file: File;
}

const MAX_CONCURRENT_UPLOADS = 2;

// Sentinel value for the "skip ingestion" option in the collection dropdown.
// Picked so it can't collide with a real Milvus collection name (underscores
// are stripped/collapsed during normalization).
const INLINE_MODE = '__inline__';

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

function describeUploadError(err: unknown, status?: number): string {
  if (err instanceof DOMException && err.name === 'AbortError')
    return 'Cancelled';
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    status === 413 ||
    lower.includes('size limit') ||
    lower.includes('payload too large')
  ) {
    return 'File exceeds the size limit.';
  }
  if (status === 415 || lower.includes('unsupported')) {
    return 'Unsupported file type.';
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'Connection lost. Check your network.';
  }
  return raw || 'Upload failed.';
}

interface ChatInputProps {
  onSend: (message: Message) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

function classifyFile(
  file: File,
): 'image' | 'document' | 'video' | 'transcript' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (isVTTFile(file)) return 'transcript';
  return 'document';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const ChatInput = memo(
  ({ onSend, onStop, isStreaming = false }: ChatInputProps) => {
    const [content, setContent] = useState('');
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [uploading, setUploading] = useState<UploadingFile[]>([]);
    const [selectedCollection, setSelectedCollection] = useState<string>('');
    const [showCollections, setShowCollections] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isMobile = useIsMobile();

    const hasDocumentAttachment = attachments.some(
      (a) => a.type === 'document',
    );
    const { data: collections = [] } = useMilvusCollections(
      hasDocumentAttachment,
    );
    const uploadControllers = useRef<Map<string, AbortController>>(new Map());
    const pendingUploads = useRef<PendingUpload[]>([]);
    const activeUploadCount = useRef(0);
    const uploadQueueDrain = useRef<() => void>(() => {});
    const uploadComponentMounted = useRef(true);
    const isUploading = uploading.some((u) => u.progress < 100 && !u.error);
    const canSend =
      (content.trim() || attachments.length > 0) &&
      !isStreaming &&
      !isUploading;

    // Show collection selector when documents are attached
    useEffect(() => {
      if (hasDocumentAttachment && !showCollections) {
        setShowCollections(true);
      } else if (!hasDocumentAttachment) {
        setShowCollections(false);
        setSelectedCollection('');
      }
    }, [hasDocumentAttachment, showCollections]);

    const uploadFile = useCallback(
      async (file: File, existingUploadId?: string) => {
        const type = classifyFile(file);
        const validation = validateFileSize(file, type);
        if (!validation.valid) {
          toast.error(validation.error || 'File too large');
          return;
        }

        const uploadId =
          existingUploadId ?? `upload-${Date.now()}-${Math.random()}`;
        const controller = new AbortController();
        uploadControllers.current.set(uploadId, controller);

        if (existingUploadId) {
          setUploading((prev) =>
            prev.map((u) =>
              u.id === uploadId ? { ...u, progress: 10, error: undefined } : u,
            ),
          );
        } else {
          setUploading((prev) => [
            ...prev,
            { id: uploadId, file, type, progress: 10 },
          ]);
        }

        const releaseController = () => {
          uploadControllers.current.delete(uploadId);
        };

        try {
          if (type === 'transcript') {
            setUploading((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, progress: 30 } : u)),
            );
            const vttRef = await uploadVTTFile(file, controller.signal);
            setUploading((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, progress: 100 } : u,
              ),
            );

            const attachment: Attachment = {
              content: file.name,
              type: 'transcript',
              vttRef: {
                vttId: vttRef.vttId,
                sessionId: vttRef.sessionId,
                filename: file.name,
                mimeType: file.type || 'text/vtt',
              },
            };
            setAttachments((prev) => [...prev, attachment]);

            setTimeout(() => {
              setUploading((prev) => prev.filter((u) => u.id !== uploadId));
            }, 1000);
            releaseController();
            return;
          }

          setUploading((prev) =>
            prev.map((u) => (u.id === uploadId ? { ...u, progress: 50 } : u)),
          );

          if (type === 'image') {
            const base64 = await fileToBase64(file);
            if (controller.signal.aborted) {
              throw new DOMException('Upload aborted', 'AbortError');
            }
            const imageRef = await uploadImage(
              base64,
              file.type,
              controller.signal,
            );
            setUploading((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, progress: 100 } : u,
              ),
            );

            const attachment: Attachment = {
              content: file.name,
              type: 'image',
              imageRef: {
                imageId: imageRef.imageId,
                sessionId: imageRef.sessionId,
                mimeType: file.type,
                ...(imageRef.userId && { userId: imageRef.userId }),
              },
            };
            setAttachments((prev) => [...prev, attachment]);
          } else if (type === 'document') {
            const documentRef = await uploadDocument(file, controller.signal);
            setUploading((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, progress: 100 } : u,
              ),
            );

            const attachment: Attachment = {
              content: file.name,
              type: 'document',
              documentRef: {
                documentId: documentRef.documentId,
                sessionId: documentRef.sessionId,
                filename: documentRef.filename || file.name,
                mimeType:
                  documentRef.mimeType ||
                  file.type ||
                  'application/octet-stream',
                ...(documentRef.userId && { userId: documentRef.userId }),
              },
            };
            setAttachments((prev) => [...prev, attachment]);
          } else if (type === 'video') {
            const base64 = await fileToBase64(file);
            if (controller.signal.aborted) {
              throw new DOMException('Upload aborted', 'AbortError');
            }
            const videoRef = await uploadVideo(
              base64,
              file.name,
              getVideoMimeType(file),
              controller.signal,
            );
            setUploading((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, progress: 100 } : u,
              ),
            );

            const attachment: Attachment = {
              content: file.name,
              type: 'video',
              videoRef: {
                videoId: videoRef.videoId,
                sessionId: videoRef.sessionId,
                filename: file.name,
                mimeType: videoRef.mimeType || file.type,
                ...(videoRef.userId && { userId: videoRef.userId }),
              },
            };
            setAttachments((prev) => [...prev, attachment]);
          }

          setTimeout(() => {
            setUploading((prev) => prev.filter((u) => u.id !== uploadId));
          }, 1000);
          releaseController();
        } catch (err: any) {
          releaseController();
          if (err instanceof DOMException && err.name === 'AbortError') {
            setUploading((prev) => prev.filter((u) => u.id !== uploadId));
            return;
          }
          console.error('Upload failed:', err);
          const friendly = describeUploadError(err);
          setUploading((prev) =>
            prev.map((u) =>
              u.id === uploadId ? { ...u, error: friendly, progress: 0 } : u,
            ),
          );
        }
      },
      [],
    );

    const drainUploadQueue = useCallback(() => {
      while (
        uploadComponentMounted.current &&
        activeUploadCount.current < MAX_CONCURRENT_UPLOADS &&
        pendingUploads.current.length > 0
      ) {
        const next = pendingUploads.current.shift();
        if (!next) break;
        activeUploadCount.current += 1;
        void uploadFile(next.file, next.id).finally(() => {
          activeUploadCount.current = Math.max(
            0,
            activeUploadCount.current - 1,
          );
          uploadQueueDrain.current();
        });
      }
    }, [uploadFile]);
    uploadQueueDrain.current = drainUploadQueue;

    const enqueueUpload = useCallback(
      (file: File, existingUploadId?: string) => {
        if (
          existingUploadId &&
          (uploadControllers.current.has(existingUploadId) ||
            pendingUploads.current.some(
              (upload) => upload.id === existingUploadId,
            ))
        ) {
          return;
        }
        const type = classifyFile(file);
        const validation = validateFileSize(file, type);
        if (!validation.valid) {
          toast.error(validation.error || 'File too large');
          return;
        }

        const uploadId =
          existingUploadId ?? `upload-${Date.now()}-${Math.random()}`;
        if (existingUploadId) {
          setUploading((prev) =>
            prev.map((upload) =>
              upload.id === uploadId
                ? { ...upload, progress: 0, error: undefined }
                : upload,
            ),
          );
        } else {
          setUploading((prev) => [
            ...prev,
            { id: uploadId, file, type, progress: 0 },
          ]);
        }
        pendingUploads.current.push({ id: uploadId, file });
        uploadQueueDrain.current();
      },
      [],
    );

    const cancelUpload = useCallback((uploadId: string) => {
      const controller = uploadControllers.current.get(uploadId);
      if (controller) {
        controller.abort();
        return;
      }

      const queuedIndex = pendingUploads.current.findIndex(
        (upload) => upload.id === uploadId,
      );
      if (queuedIndex >= 0) {
        pendingUploads.current.splice(queuedIndex, 1);
        setUploading((prev) => prev.filter((upload) => upload.id !== uploadId));
      }
    }, []);

    const retryUpload = useCallback(
      (uploadId: string) => {
        const entry = uploading.find((u) => u.id === uploadId);
        if (!entry) return;
        enqueueUpload(entry.file, uploadId);
      },
      [uploading, enqueueUpload],
    );

    const dismissUpload = useCallback((uploadId: string) => {
      setUploading((prev) => prev.filter((u) => u.id !== uploadId));
    }, []);

    useEffect(() => {
      uploadComponentMounted.current = true;
      const controllers = uploadControllers.current;
      return () => {
        uploadComponentMounted.current = false;
        pendingUploads.current = [];
        controllers.forEach((c) => c.abort());
        controllers.clear();
      };
    }, []);

    const handleFileSelect = useCallback(
      (files: File[]) => {
        const activeOrQueued = uploading.filter(
          (upload) => upload.progress < 100 && !upload.error,
        );
        const existingCounts = {
          image:
            attachments.filter((attachment) => attachment.type === 'image')
              .length +
            activeOrQueued.filter((upload) => upload.type === 'image').length,
          document:
            attachments.filter((attachment) => attachment.type === 'document')
              .length +
            activeOrQueued.filter((upload) => upload.type === 'document')
              .length,
          video:
            attachments.filter((attachment) => attachment.type === 'video')
              .length +
            activeOrQueued.filter((upload) => upload.type === 'video').length,
          transcript:
            attachments.filter((attachment) => attachment.type === 'transcript')
              .length +
            activeOrQueued.filter((upload) => upload.type === 'transcript')
              .length,
        };
        const limits = {
          image: UPLOAD_LIMITS.MAX_IMAGES_PER_BATCH,
          document: UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH,
          video: UPLOAD_LIMITS.MAX_VIDEOS_PER_BATCH,
          transcript: UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH,
        };
        const { accepted: allowed, rejected: droppedCounts } = admitUploadBatch(
          files,
          classifyFile,
          existingCounts,
          limits,
        );

        const rejectedTypes = (
          Object.entries(droppedCounts) as Array<
            [keyof typeof droppedCounts, number]
          >
        ).filter(([, count]) => count > 0);
        if (rejectedTypes.length > 0) {
          const summary = rejectedTypes
            .map(
              ([type, count]) =>
                `${count} ${type} file${count === 1 ? '' : 's'}`,
            )
            .join(', ');
          toast.error(
            `Upload batch limit reached. Skipped ${summary}. Split them into multiple requests.`,
            { duration: 8000 },
          );
        }

        for (const file of allowed) {
          enqueueUpload(file);
        }
      },
      [attachments, uploading, enqueueUpload],
    );

    const removeAttachment = useCallback((index: number) => {
      setAttachments((prev) => prev.filter((_, i) => i !== index));
    }, []);

    // Convert an uploaded document to a full Markdown file and download it
    // locally. Goes directly to the typed REST route (no LLM) and uses the same
    // blob-download pattern as generated images (Web Share API, then anchor).
    const downloadDocumentAsMarkdown = useCallback(
      async (
        documentRef: NonNullable<Attachment['documentRef']>,
        filename?: string,
      ) => {
        const label = filename || 'document';
        const loadingToast = toast.loading(
          `Converting ${label} to Markdown...`,
        );
        try {
          const response = await fetch('/api/document/markdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentRef, filename }),
          });
          if (!response.ok) {
            let message = 'Failed to convert document to Markdown';
            try {
              const payload = await response.json();
              message = payload?.details || payload?.error || message;
            } catch {
              // Non-JSON error body; keep the default message.
            }
            toast.dismiss(loadingToast);
            toast.error(message);
            return;
          }
          const blob = await response.blob();
          const downloadName =
            filenameFromContentDisposition(
              response.headers.get('Content-Disposition'),
            ) || `${label.replace(/\.[^./\\]+$/, '')}.md`;

          // Try the Web Share API first (mobile), then fall back to a download.
          if (
            typeof navigator !== 'undefined' &&
            navigator.canShare &&
            navigator.share
          ) {
            try {
              const file = new File([blob], downloadName, {
                type: 'text/markdown',
              });
              if (navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: downloadName });
                toast.dismiss(loadingToast);
                return;
              }
            } catch {
              // Share cancelled/unsupported — fall through to download.
            }
          }

          const url = window.URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = downloadName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.URL.revokeObjectURL(url);
          toast.dismiss(loadingToast);
          if (response.headers.get('X-Document-Truncated') === 'true') {
            toast('Document was very large and was truncated.', {
              duration: 6000,
            });
          }
        } catch (err) {
          toast.dismiss(loadingToast);
          console.error('Markdown download failed:', err);
          toast.error('Failed to convert document — check backend logs.');
        }
      },
      [],
    );

    const handleSend = useCallback(async () => {
      if (!canSend) return;

      // Build message content with routing hints for the backend
      let messageContent = content.trim();
      const messageAttachments = [...attachments];
      const isInlineMode = selectedCollection === INLINE_MODE;

      // Inline mode: extract the document to markdown via the backend, then
      // embed the markdown directly in the user message so the LLM sees the
      // doc text without going through the RAG pipeline.
      if (isInlineMode) {
        const docAttachments = attachments.filter(
          (a) => a.type === 'document' && a.documentRef,
        );
        if (docAttachments.length !== 1) {
          toast.error(
            'Inline mode supports exactly one document at a time. ' +
              'Remove extra docs or pick a knowledge base instead.',
          );
          return;
        }
        const docAtt = docAttachments[0];
        const loadingToast = toast.loading(
          `Extracting ${docAtt.content || 'document'}...`,
        );
        try {
          const response = await fetch('/api/document/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'extract',
              documentRef: docAtt.documentRef,
              filename: docAtt.content,
            }),
          });
          const payload = await response.json();
          if (!response.ok || !payload.success) {
            toast.dismiss(loadingToast);
            toast.error(
              payload?.error ||
                payload?.details ||
                'Failed to extract document',
            );
            return;
          }
          const markdown: string = payload.markdown || '';
          const filename: string =
            payload.filename || docAtt.content || 'document';
          const truncated: boolean = payload.truncated === true;
          const originalChars: number =
            typeof payload.originalChars === 'number'
              ? payload.originalChars
              : 0;
          const pages: number =
            typeof payload.pages === 'number' ? payload.pages : 0;
          const attrs = [
            `filename="${escapeXmlAttr(filename)}"`,
            `pages="${pages}"`,
          ];
          if (truncated) {
            attrs.push('truncated="true"');
            attrs.push(`original_chars="${originalChars}"`);
          }
          const docBlock = `<attached_document ${attrs.join(
            ' ',
          )}>\n${markdown}\n</attached_document>`;
          messageContent = messageContent
            ? `${messageContent}\n\n${docBlock}`
            : docBlock;
          toast.dismiss(loadingToast);
          if (truncated) {
            toast(
              `Document truncated to 50K chars (was ${originalChars.toLocaleString()}).`,
              { duration: 5000 },
            );
          }
        } catch (err) {
          toast.dismiss(loadingToast);
          console.error('Inline extract failed:', err);
          toast.error('Failed to extract document — check backend logs.');
          return;
        }
      } else if (hasDocumentAttachment && selectedCollection) {
        messageContent =
          messageContent ||
          `Ingest the uploaded document(s) into the "${selectedCollection}" knowledge base.`;
      }

      // Add routing hint for transcripts without text
      if (!messageContent && attachments.some((a) => a.type === 'transcript')) {
        messageContent =
          'Summarize this meeting transcript and create structured notes.';
      }

      // Add routing hint for images without text
      if (!messageContent && attachments.some((a) => a.type === 'image')) {
        messageContent = 'Analyze this image and describe what you see.';
      }

      const message: Message = {
        role: 'user',
        content: messageContent,
        attachments:
          messageAttachments.length > 0 ? messageAttachments : undefined,
        metadata: {
          ...(!isInlineMode && selectedCollection
            ? {
                targetCollection: selectedCollection,
                collectionScope: 'user',
              }
            : {}),
        },
      };

      onSend(message);
      setContent('');
      setAttachments([]);
      setSelectedCollection('');
      setShowCollections(false);

      setTimeout(() => textareaRef.current?.focus(), 50);
    }, [
      content,
      attachments,
      canSend,
      onSend,
      hasDocumentAttachment,
      selectedCollection,
    ]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        // On mobile, Enter inserts a newline and the send button submits.
        // Never submit mid-IME-composition (e.g. CJK input).
        if (
          e.key === 'Enter' &&
          !e.shiftKey &&
          !e.nativeEvent.isComposing &&
          !isMobile
        ) {
          e.preventDefault();
          handleSend();
        }
      },
      [handleSend, isMobile],
    );

    // Paste-to-upload: screenshots and files from the clipboard
    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length > 0) {
          e.preventDefault();
          handleFileSelect(files);
        }
      },
      [handleFileSelect],
    );

    return (
      <GlassToolbar className="flex-shrink-0 py-3">
        <div className="chat-content-rail space-y-2">
          <DropZone onDrop={handleFileSelect}>
            {/* Upload progress bars */}
            {uploading.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {uploading.map((u) => (
                  <div
                    key={u.id}
                    className={classNames(
                      'flex items-center gap-2 text-xs px-2 py-1 rounded-md',
                      u.error && 'bg-nvidia-red/5 border border-nvidia-red/20',
                    )}
                  >
                    {u.type === 'image' ? (
                      <IconPhoto size={14} className="text-nvidia-green" />
                    ) : u.type === 'document' ? (
                      <IconFileText size={14} className="text-nvidia-blue" />
                    ) : u.type === 'transcript' ? (
                      <IconNotes size={14} className="text-nvidia-yellow" />
                    ) : (
                      <IconPhoto size={14} className="text-nvidia-purple" />
                    )}
                    <span className="text-dark-text-muted truncate flex-1">
                      {u.file.name}
                    </span>
                    {u.error ? (
                      <>
                        <span className="text-nvidia-red whitespace-nowrap">
                          {u.error}
                        </span>
                        <button
                          type="button"
                          onClick={() => retryUpload(u.id)}
                          aria-label="Retry upload"
                          className="p-0.5 rounded text-nvidia-red hover:bg-nvidia-red/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-red/40"
                        >
                          <IconRefresh size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => dismissUpload(u.id)}
                          aria-label="Dismiss"
                          className="p-0.5 rounded text-dark-text-muted hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                        >
                          <IconX size={12} />
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="w-20">
                          <ProgressBar
                            value={u.progress}
                            size="sm"
                            variant={u.progress === 100 ? 'success' : 'accent'}
                          />
                        </div>
                        {u.progress < 100 && (
                          <button
                            type="button"
                            onClick={() => cancelUpload(u.id)}
                            aria-label="Cancel upload"
                            className="p-0.5 rounded text-dark-text-muted hover:bg-white/[0.05] hover:text-dark-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                          >
                            <IconX size={12} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Attachment previews */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {attachments.map((att, i) => (
                  <div
                    key={i}
                    className={classNames(
                      'inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-xs border',
                      att.type === 'image'
                        ? 'bg-nvidia-green/5 border-nvidia-green/20 text-nvidia-green'
                        : att.type === 'document'
                        ? 'bg-nvidia-blue/5 border-nvidia-blue/20 text-nvidia-blue'
                        : att.type === 'transcript'
                        ? 'bg-nvidia-yellow/5 border-nvidia-yellow/20 text-nvidia-yellow'
                        : 'bg-nvidia-purple/5 border-nvidia-purple/20 text-nvidia-purple',
                    )}
                  >
                    {att.type === 'image' ? (
                      <IconPhoto size={12} />
                    ) : att.type === 'document' ? (
                      <IconFileText size={12} />
                    ) : att.type === 'transcript' ? (
                      <IconNotes size={12} />
                    ) : (
                      <IconPhoto size={12} />
                    )}
                    <span className="truncate max-w-[120px]">
                      {att.content}
                    </span>
                    {att.type === 'document' && att.documentRef && (
                      <button
                        onClick={() =>
                          downloadDocumentAsMarkdown(
                            att.documentRef!,
                            att.content,
                          )
                        }
                        className="p-0.5 rounded hover:bg-white/10 transition-colors"
                        aria-label="Download as Markdown"
                        title="Download as Markdown"
                      >
                        <IconFileDownload size={12} />
                      </button>
                    )}
                    <button
                      onClick={() => removeAttachment(i)}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                      aria-label="Remove attachment"
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Collection selector for documents */}
            {showCollections && (
              <div className="flex items-center gap-2 mb-2 px-1">
                <IconDatabase
                  size={14}
                  className="text-nvidia-blue flex-shrink-0"
                />
                <span className="text-xs text-dark-text-muted flex-shrink-0">
                  Ingest to:
                </span>
                <select
                  value={selectedCollection}
                  onChange={(e) => setSelectedCollection(e.target.value)}
                  className="flex-1 bg-dark-bg-tertiary text-dark-text-primary text-xs border border-white/10 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-nvidia-green/30"
                >
                  <option value="">Select a knowledge base...</option>
                  <option value={INLINE_MODE}>
                    Read inline (skip ingest, single doc)
                  </option>
                  {collections.length > 0 && (
                    <option value="" disabled>
                      ── knowledge bases ──
                    </option>
                  )}
                  {collections.map((collection) => (
                    <option key={collection.name} value={collection.name}>
                      {collection.displayName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Input row */}
            <div className="flex items-end gap-2">
              <IconButton
                icon={<IconPaperclip />}
                aria-label="Attach file"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="flex-shrink-0 mb-0.5"
              />

              <div className="flex-1 min-w-0">
                <Textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    hasDocumentAttachment
                      ? 'Add instructions or send to ingest...'
                      : attachments.some((a) => a.type === 'transcript')
                      ? 'Ask about this transcript (e.g. "summarize this meeting")...'
                      : attachments.some((a) => a.type === 'image')
                      ? 'Ask about this image...'
                      : 'Send a message...'
                  }
                  maxRows={6}
                  autoResize
                  className="bg-dark-bg-tertiary"
                />
              </div>

              {isStreaming ? (
                <IconButton
                  icon={<IconSquare />}
                  aria-label="Stop generating"
                  variant="danger"
                  size="md"
                  onClick={onStop}
                  className="flex-shrink-0 mb-0.5"
                />
              ) : (
                <IconButton
                  icon={<IconSend />}
                  aria-label="Send message"
                  variant={canSend ? 'accent' : 'ghost'}
                  size="md"
                  onClick={handleSend}
                  disabled={!canSend}
                  className="flex-shrink-0 mb-0.5"
                />
              )}
            </div>
          </DropZone>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/x-flv,video/3gpp,.pdf,.docx,.pptx,.html,.htm,.txt,text/plain,.md,.markdown,text/markdown,text/x-markdown,text/vtt,.vtt,application/x-subrip,.srt"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                handleFileSelect(Array.from(e.target.files));
                e.target.value = '';
              }
            }}
          />
        </div>
      </GlassToolbar>
    );
  },
);

ChatInput.displayName = 'ChatInput';
