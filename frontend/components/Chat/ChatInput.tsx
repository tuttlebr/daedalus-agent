import {
  IconPhoto,
  IconPlayerStopFilled,
  IconSend,
  IconTrash,
  IconPaperclip,
  IconBrain,
  IconVideo,
  IconX,
} from '@tabler/icons-react';
import {
  KeyboardEvent,
  MutableRefObject,
  Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import type React from 'react';

import { useTranslation } from 'next-i18next';
import toast from 'react-hot-toast';

import { Message, Conversation } from '@/types/chat';
import { v4 as uuidv4 } from 'uuid';

import HomeContext from '@/pages/api/home/home.context';
import { compressImage } from '@/utils/app/helper';
import { withTimeout } from '@/utils/fetchWithTimeout';
import { appConfig } from '@/utils/app/const';
import { uploadImage, ImageReference } from '@/utils/app/imageHandler';
import { uploadDocument, DocumentReference } from '@/utils/app/documentHandler';
import { uploadVideo, VideoReference, isVideoFile, validateVideoFile, getVideoMimeType, getVideoUrl, SUPPORTED_VIDEO_EXTENSIONS } from '@/utils/app/videoHandler';
import { UPLOAD_LIMITS, formatFileSize, validateFileSize } from '@/constants/uploadLimits';
import { setUserSessionItem } from '@/utils/app/storage';
import { saveConversation, saveConversations } from '@/utils/app/conversation';
import { OptimizedImage } from './OptimizedImage';
import { QuickActions } from './QuickActions';
import { QuickActionsPopup } from './QuickActionsPopup';
import { CollectionSelector } from './CollectionSelector';
import { useAuth } from '@/components/Auth/AuthProvider';
import { Logger } from '@/utils/logger';

const logger = new Logger('ChatInput');

// Image compression timeout (10 seconds)
const COMPRESSION_TIMEOUT_MS = 10000;

/**
 * Wraps compressImage with a timeout to prevent indefinite hangs.
 * Falls back to original image if compression times out.
 */
const compressImageWithTimeout = (
  image: string,
  type: string,
  quality: boolean,
  timeoutMs = COMPRESSION_TIMEOUT_MS
): Promise<string> => {
  const compressionPromise = new Promise<string>((resolve) => {
    compressImage(image, type, quality, (compressedBase64: string) => {
      resolve(compressedBase64);
    });
  });

  return withTimeout(
    compressionPromise,
    timeoutMs,
    new Error('Image compression timed out')
  ).catch((error) => {
    console.warn('Image compression timed out, using original image:', error.message);
    return image; // Fall back to original image
  });
};


interface Props {
  onSend: (message: Message) => void;
  onRegenerate: () => void;
  onScrollDownClick: () => void;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  showScrollDownButton: boolean;
  controller: MutableRefObject<AbortController>;
  onStop?: () => void;
  isStreaming?: boolean;
  isAnyStreaming?: boolean;
  onQuickActionsRegister?: (handlers: {
    onAttachFile: () => void;
    onTakePhoto: () => void;
    onToggleDeepThought: () => void;
  }) => void;
  onFocusChange?: (isFocused: boolean) => void;
}

export const ChatInput: React.FC<Props> = ({
  onSend,
  onScrollDownClick,
  textareaRef,
  showScrollDownButton,
  controller,
  onStop,
  isStreaming,
  isAnyStreaming,
  onQuickActionsRegister,
  onFocusChange,
}) => {
  const { t } = useTranslation('chat');
  const { user, isLoading: authLoading } = useAuth();

  // Auth state computed properties
  const isAuthenticated = !authLoading && user !== null;
  const canSendMessage = !authLoading; // Allow sending even if not logged in, but memory won't work

  const {
    state: { selectedConversation, messageIsStreaming, streamingByConversationId, enableIntermediateSteps, conversations, useDeepThinker },
    dispatch: homeDispatch,
  } = useContext(HomeContext);
  const selectedConversationId = selectedConversation?.id;

  // Use refs to avoid stale closures in async callbacks (like document processing)
  const selectedConversationRef = useRef(selectedConversation);
  const conversationsRef = useRef(conversations);

  // Keep refs in sync with state on every render
  selectedConversationRef.current = selectedConversation;
  conversationsRef.current = conversations;
  const selectedConversationStreaming = selectedConversationId
    ? Boolean(streamingByConversationId[selectedConversationId])
    : false;
  const resolvedIsStreaming = isStreaming ?? selectedConversationStreaming;
  const resolvedIsAnyStreaming = isAnyStreaming ?? messageIsStreaming;

  const [content, setContent] = useState<string>('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [inputFile, setInputFile] = useState<string | null>(null);
  const [inputFileExtension, setInputFileExtension] = useState('');
  const [inputFileContent, setInputFileContent] = useState('');
  const [inputFileContentCompressed, setInputFileContentCompressed] = useState('');
  const [imageRef, setImageRef] = useState<ImageReference | null>(null);
  const [imageRefs, setImageRefs] = useState<ImageReference[]>([]);
  const [videoRef, setVideoRef] = useState<VideoReference | null>(null);
  const [videoRefs, setVideoRefs] = useState<VideoReference[]>([]);
  const [documentRefs, setDocumentRefs] = useState<Array<{ documentId: string; sessionId: string; filename?: string }>>([])
  const [transcriptContent, setTranscriptContent] = useState<{ filename: string; content: string } | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<string>('');

  // Streaming elapsed timer
  const [streamingElapsed, setStreamingElapsed] = useState(0);
  const streamingStartRef = useRef<number>(0);
  useEffect(() => {
    if (resolvedIsStreaming) {
      streamingStartRef.current = Date.now();
      setStreamingElapsed(0);
      const timer = setInterval(() => {
        setStreamingElapsed(Math.floor((Date.now() - streamingStartRef.current) / 1000));
      }, 1000);
      return () => clearInterval(timer);
    } else {
      setStreamingElapsed(0);
    }
  }, [resolvedIsStreaming]);

  // Unified upload tracking system with cancellation support
  interface UploadState {
    id: string;
    controller: AbortController;
    type: 'image' | 'video' | 'document';
    filename: string;
    progress: number;
    startedAt: number;
  }

  const activeUploadsRef = useRef<Map<string, UploadState>>(new Map());
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});

  // Create a new tracked upload
  const startTrackedUpload = useCallback((
    type: 'image' | 'video' | 'document',
    filename: string
  ): { id: string; controller: AbortController } => {
    const id = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const controller = new AbortController();

    const uploadState: UploadState = {
      id,
      controller,
      type,
      filename,
      progress: 0,
      startedAt: Date.now(),
    };

    activeUploadsRef.current.set(id, uploadState);
    setUploadProgress(prev => ({ ...prev, [id]: 0 }));

    return { id, controller };
  }, []);

  // Update upload progress
  const updateUploadProgress = useCallback((id: string, progress: number) => {
    const upload = activeUploadsRef.current.get(id);
    if (upload) {
      upload.progress = progress;
      setUploadProgress(prev => ({ ...prev, [id]: progress }));
    }
  }, []);

  // Complete and remove a tracked upload
  const completeTrackedUpload = useCallback((id: string) => {
    activeUploadsRef.current.delete(id);
    setUploadProgress(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // Cancel an upload
  const cancelUpload = useCallback((id: string) => {
    const upload = activeUploadsRef.current.get(id);
    if (upload) {
      upload.controller.abort();
      activeUploadsRef.current.delete(id);
      setUploadProgress(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast(`Upload cancelled: ${upload.filename}`, { icon: 'ℹ️' });
    }
  }, []);

  // Cancel all uploads of a specific type
  const cancelAllUploads = useCallback((type?: 'image' | 'video' | 'document') => {
    const uploadsToCancel = Array.from(activeUploadsRef.current.values())
      .filter(upload => !type || upload.type === type);

    uploadsToCancel.forEach(upload => {
      upload.controller.abort();
      activeUploadsRef.current.delete(upload.id);
    });

    if (uploadsToCancel.length > 0) {
      setUploadProgress(prev => {
        const next = { ...prev };
        uploadsToCancel.forEach(upload => delete next[upload.id]);
        return next;
      });
      toast(`Cancelled ${uploadsToCancel.length} upload(s)`, { icon: 'ℹ️' });
    }
  }, []);

  // Get active uploads count
  const activeUploadsCount = Object.keys(uploadProgress).length;
  const hasActiveUploads = activeUploadsCount > 0;

  // Track pending document uploads per conversation to prevent losing uploads on navigation
  const pendingDocumentUploadsRef = useRef<Map<string, AbortController>>(new Map());
  // Track if there's a document upload in progress for the current conversation
  const [isProcessingDocument, setIsProcessingDocument] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // State for document processing UI indicators
  const [hasPendingDocumentRefresh, setHasPendingDocumentRefresh] = useState(false);
  const [lastProcessedConversationId, setLastProcessedConversationId] = useState<string | null>(null);

  // Helper function to check if conversation needs refresh
  const checkConversationSync = useCallback((conversationId: string) => {
    const conversationInList = conversations.find(c => c.id === conversationId);
    const currentSelected = selectedConversation;

    if (!conversationInList || !currentSelected || currentSelected.id !== conversationId) {
      return false;
    }

    // Check if the conversation in the list has more messages than selected
    const listMessageCount = conversationInList.messages?.length || 0;
    const selectedMessageCount = currentSelected.messages?.length || 0;

    if (listMessageCount > selectedMessageCount) {
      logger.debug('Conversation sync mismatch detected', {
        conversationId,
        listMessageCount,
        selectedMessageCount,
        difference: listMessageCount - selectedMessageCount
      });
      return true;
    }

    return false;
  }, [conversations, selectedConversation]);

  // Function to refresh conversation from list
  const refreshConversationFromList = useCallback((conversationId: string) => {
    const conversation = conversations.find(c => c.id === conversationId);
    if (conversation) {
      homeDispatch({
        field: 'selectedConversation',
        value: conversation
      });
      logger.info('Refreshed conversation from list', { conversationId, messageCount: conversation.messages?.length });
      return true;
    }
    return false;
  }, [conversations, homeDispatch]);

  // Use centralized constants for document extraction limits
  const MAX_EXTRACTED_TEXT_CHARS = UPLOAD_LIMITS.MAX_EXTRACTED_TEXT_CHARS;
  const DOCUMENT_EXTRACT_START = '<!-- DOCUMENT_EXTRACT_START -->';
  const DOCUMENT_EXTRACT_END = '<!-- DOCUMENT_EXTRACT_END -->';
  const LARGE_DOCUMENT_THRESHOLD = UPLOAD_LIMITS.LARGE_DOCUMENT_THRESHOLD_BYTES;
  // Token estimation: ~4 chars per token for English text (conservative estimate)
  const CHARS_PER_TOKEN = 4;
  // Model context limits (approximate, leaving room for system prompt and response)
  const MODEL_CONTEXT_WARNING_TOKENS = 100000; // Warn at 100K tokens for in-context document
  const SUPPORTED_DOCUMENT_MIME_TYPES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/html',
  ]);
  const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'html', 'htm']);

  // Transcript file types (VTT, SRT) - read as text and inject into chat
  const SUPPORTED_TRANSCRIPT_MIME_TYPES = new Set(['text/vtt', 'text/srt', 'application/x-subrip']);
  const SUPPORTED_TRANSCRIPT_EXTENSIONS = new Set(['vtt', 'srt']);

  const getFileExtension = (filename: string) => {
    const parts = filename.toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() ?? '' : '';
  };

  const isDocumentFile = (file: File) => {
    if (SUPPORTED_DOCUMENT_MIME_TYPES.has(file.type)) {
      return true;
    }

    const extension = getFileExtension(file.name);
    return extension ? SUPPORTED_DOCUMENT_EXTENSIONS.has(extension) : false;
  };

  const isTranscriptFile = (file: File) => {
    if (SUPPORTED_TRANSCRIPT_MIME_TYPES.has(file.type)) {
      return true;
    }

    const extension = getFileExtension(file.name);
    return extension ? SUPPORTED_TRANSCRIPT_EXTENSIONS.has(extension) : false;
  };

  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );

  function isLikelyStatusMessage(text: string) {
    const lowered = text.toLowerCase();
    return (
      lowered.includes('successfully processed') ||
      lowered.includes('partially processed') ||
      lowered.includes('documents indexed') ||
      lowered.includes('failed to process') ||
      lowered.includes('processing document')
    );
  }

  function tryParseJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const tryParse = (candidate: string) => {
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        return null;
      }
    };

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryParse(trimmed);
      if (parsed !== null) {
        return parsed;
      }
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const parsed = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed !== null) {
        return parsed;
      }
    }

    return trimmed;
  }

  interface NormalizedTextResult {
    text: string;
    wasTruncated: boolean;
    originalLength: number;
    truncatedLength: number;
    truncatedPercent: number;
    estimatedTokens: number;
  }

  // Estimate token count from character count (rough approximation)
  const estimateTokens = (charCount: number): number => {
    return Math.ceil(charCount / CHARS_PER_TOKEN);
  };

  function normalizeExtractedText(text: string): NormalizedTextResult | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const originalLength = trimmed.length;
    const originalTokens = estimateTokens(originalLength);

    if (originalLength <= MAX_EXTRACTED_TEXT_CHARS) {
      return {
        text: trimmed,
        wasTruncated: false,
        originalLength,
        truncatedLength: originalLength,
        truncatedPercent: 0,
        estimatedTokens: originalTokens
      };
    }

    const truncatedPercent = Math.round((1 - MAX_EXTRACTED_TEXT_CHARS / originalLength) * 100);
    const truncatedTokens = estimateTokens(MAX_EXTRACTED_TEXT_CHARS);

    // Split budget equally across beginning, middle, and end chunks (no overlap)
    const chunkSize = Math.floor(MAX_EXTRACTED_TEXT_CHARS / 3);
    const middleStart = Math.floor((originalLength - chunkSize) / 2);

    const beginningChunk = trimmed.slice(0, chunkSize);
    const middleChunk = trimmed.slice(middleStart, middleStart + chunkSize);
    const endChunk = trimmed.slice(originalLength - chunkSize);

    const omittedBetweenBeginAndMiddle = middleStart - chunkSize;
    const omittedBetweenMiddleAndEnd = (originalLength - chunkSize) - (middleStart + chunkSize);

    const truncatedText = [
      beginningChunk,
      `\n\n[... ${omittedBetweenBeginAndMiddle.toLocaleString()} characters omitted ...]\n\n`,
      middleChunk,
      `\n\n[... ${omittedBetweenMiddleAndEnd.toLocaleString()} characters omitted ...]\n\n`,
      endChunk,
      `\n\n[Document truncated: showing ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} of ${originalLength.toLocaleString()} characters from beginning, middle, and end (${truncatedPercent}% omitted). For full document analysis, use the RAG search feature instead.]`,
    ].join('');

    return {
      text: truncatedText,
      wasTruncated: true,
      originalLength,
      truncatedLength: MAX_EXTRACTED_TEXT_CHARS,
      truncatedPercent,
      estimatedTokens: truncatedTokens
    };
  }

  function extractTextFromUnknown(value: unknown): NormalizedTextResult | null {
    // DEBUG: Log extraction attempt
    const debugInfo = {
      valueType: typeof value,
      valueIsNull: value === null || value === undefined,
      valueIsArray: Array.isArray(value),
      valueKeys: value && typeof value === 'object' ? Object.keys(value) : [],
      attemptedKeys: [] as string[],
      foundKey: null as string | null,
      extractionPath: [] as string[]
    };

    if (value === null || value === undefined) {
      logger.debug('extractTextFromUnknown: value is null/undefined');
      return null;
    }

    if (typeof value === 'string') {
      debugInfo.extractionPath.push('string');
      const parsed = tryParseJson(value);
      if (typeof parsed === 'string') {
        if (isLikelyStatusMessage(parsed)) {
          logger.debug('extractTextFromUnknown: detected status message, skipping');
          return null;
        }
        const result = normalizeExtractedText(parsed);
        logger.debug('extractTextFromUnknown: extracted from string', { textLength: result?.text?.length });
        return result;
      }
      return extractTextFromUnknown(parsed);
    }

    if (Array.isArray(value)) {
      debugInfo.extractionPath.push('array');
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const extracted = extractTextFromUnknown(item);
        if (extracted) {
          logger.debug('extractTextFromUnknown: extracted from array item', { index: i, textLength: extracted.text?.length });
          return extracted;
        }
      }
      logger.debug('extractTextFromUnknown: no valid text found in array', { itemCount: value.length });
      return null;
    }

    if (isRecord(value)) {
      debugInfo.extractionPath.push('object');
      const stringKeys = [
        'extracted_text',
        'extractedText',
        'text',
        'content',
        'document',
        'document_text',
        'body',
      ];

      for (const key of stringKeys) {
        debugInfo.attemptedKeys.push(key);
        const candidate = value[key];
        if (typeof candidate === 'string') {
          debugInfo.foundKey = key;
          const result = normalizeExtractedText(candidate);
          logger.debug('extractTextFromUnknown: extracted from object key', {
            key,
            textLength: result?.text?.length,
            candidateLength: candidate.length
          });
          return result;
        }
      }

      // Try pages array
      const pages = value.pages;
      if (Array.isArray(pages)) {
        debugInfo.extractionPath.push('pages');
        const pageText = pages
          .map((page) => {
            if (isRecord(page)) {
              const text = page.text ?? page.content;
              return typeof text === 'string' ? text : null;
            }
            return null;
          })
          .filter((text): text is string => Boolean(text));
        if (pageText.length > 0) {
          const result = normalizeExtractedText(pageText.join('\n\n'));
          logger.debug('extractTextFromUnknown: extracted from pages', { pageCount: pageText.length, textLength: result?.text?.length });
          return result;
        }
      }

      // Try chunks array
      const chunks = value.chunks;
      if (Array.isArray(chunks)) {
        debugInfo.extractionPath.push('chunks');
        const chunkText = chunks
          .map((chunk) => {
            if (isRecord(chunk)) {
              const text = chunk.text ?? chunk.content;
              return typeof text === 'string' ? text : null;
            }
            return null;
          })
          .filter((text): text is string => Boolean(text));
        if (chunkText.length > 0) {
          const result = normalizeExtractedText(chunkText.join('\n\n'));
          logger.debug('extractTextFromUnknown: extracted from chunks', { chunkCount: chunkText.length, textLength: result?.text?.length });
          return result;
        }
      }

      // Try documents array
      const documents = value.documents;
      if (Array.isArray(documents) && documents.length > 0) {
        debugInfo.extractionPath.push('documents[0]');
        const result = extractTextFromUnknown(documents[0]);
        if (result) {
          logger.debug('extractTextFromUnknown: extracted from documents[0]', { textLength: result.text?.length });
          return result;
        }
      }

      // Try nested data
      const data = value.data;
      if (data) {
        debugInfo.extractionPath.push('data');
        const result = extractTextFromUnknown(data);
        if (result) {
          logger.debug('extractTextFromUnknown: extracted from nested data', { textLength: result.text?.length });
          return result;
        }
      }

      // Log detailed failure info
      logger.warn('extractTextFromUnknown: Failed to extract text from object', debugInfo);
      logger.warn('Available object keys', { keys: Object.keys(value) });
      logger.warn('Sample object values', Object.fromEntries(
        Object.entries(value).slice(0, 5).map(([k, v]) => [k, typeof v === 'string' ? v.substring(0, 100) : typeof v])
      ));
    }

    logger.debug('extractTextFromUnknown: No extraction possible', debugInfo);
    return null;
  }

  const triggerFileUpload = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, []);

  const triggerPhotoUpload = useCallback(() => {
    if (photoInputRef.current) {
      photoInputRef.current.click();
    }
  }, []);

  const handleInputFileDelete = () => {
    setInputFile(null);
    setInputFileExtension('');
    setInputFileContent('');
    setInputFileContentCompressed('');
    setImageRef(null);
    setImageRefs([]);
    setVideoRef(null);
    setVideoRefs([]);
    setDocumentRefs([]);
    setTranscriptContent(null);
    setSelectedCollection('');
  };

  const handleToggleDeepThinker = useCallback(() => {
    const nextValue = !useDeepThinker;
    homeDispatch({ field: 'useDeepThinker', value: nextValue });
    if (nextValue && !enableIntermediateSteps) {
      homeDispatch({ field: 'enableIntermediateSteps', value: true });
      setUserSessionItem('enableIntermediateSteps', 'true');
    }
  }, [homeDispatch, useDeepThinker, enableIntermediateSteps]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;

    if (files && files.length > 0) {
      // Check if all files are documents, images, videos, or transcripts (don't mix types)
      const fileArray = Array.from(files);
      const fileTypes = fileArray.map((f: File) => {
        if (isTranscriptFile(f)) return 'transcript';
        if (isDocumentFile(f)) return 'document';
        if (isVideoFile(f)) return 'video';
        return 'image';
      });
      const allDocuments = fileTypes.every(type => type === 'document');
      const allImages = fileTypes.every(type => type === 'image');
      const allVideos = fileTypes.every(type => type === 'video');
      const allTranscripts = fileTypes.every(type => type === 'transcript');

      if (!allDocuments && !allImages && !allVideos && !allTranscripts) {
        alert('Please select files of the same type (documents, images, videos, or transcripts).');
        e.target.value = ''; // Reset after error
        return;
      }

      if (allTranscripts) {
        // Only allow one transcript at a time
        if (fileArray.length > 1) {
          alert('Please select only one transcript file at a time.');
          e.target.value = '';
          return;
        }
        // Validate file size
        const file = fileArray[0];
        if (file.size > UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_BYTES) {
          alert(`Transcript file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum size is ${UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_MB}MB.`);
          e.target.value = '';
          return;
        }
        // Process transcript file
        processTranscriptFile(file);
      } else if (allDocuments) {
        // Check if too many documents are selected
        if (fileArray.length > UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH) {
          alert(`Too many documents selected (${fileArray.length}). Please select no more than ${UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH} documents at a time to avoid processing timeouts.`);
          e.target.value = ''; // Reset after error
          return;
        }
        // Process multiple documents
        processMultipleFiles(fileArray);
      } else if (allVideos) {
        // For videos, only allow one at a time for now
        if (fileArray.length > UPLOAD_LIMITS.MAX_VIDEOS_PER_BATCH) {
          alert(`Please select only ${UPLOAD_LIMITS.MAX_VIDEOS_PER_BATCH} video at a time.`);
          e.target.value = ''; // Reset after error
          return;
        }
        // Validate and process video
        const file = fileArray[0];
        const validation = validateVideoFile(file);
        if (!validation.valid) {
          alert(validation.error);
          e.target.value = '';
          return;
        }
        processVideoFile(file);
      } else {
        // For images, check if multiple are selected
        if (fileArray.length > UPLOAD_LIMITS.MAX_IMAGES_PER_BATCH) {
          alert(`Too many images selected (${fileArray.length}). Please select no more than ${UPLOAD_LIMITS.MAX_IMAGES_PER_BATCH} images at a time.`);
          e.target.value = ''; // Reset after error
          return;
        }

        if (fileArray.length > 1) {
          // Process multiple images
          processMultipleImages(fileArray);
        } else {
          // Process single image (existing behavior for backward compatibility)
          const file = files[0];
          const reader = new FileReader();
          reader.onload = (loadEvent) => {
            const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
            processFile({ fullBase64String, file });
          };
          reader.readAsDataURL(file);
        }
      }

      // Reset the input value after processing so the same file can be selected again if needed
      e.target.value = '';
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;

    setContent(value);
  };

  const processMultipleFiles = async (files: File[]) => {
    const newDocumentRefs: Array<{ documentId: string; sessionId: string; filename?: string }> = [];
    setIsUploadingImage(true);

    // Start tracked upload for cancellation support
    const { id: uploadId, controller } = startTrackedUpload(
      'document',
      files.length === 1 ? files[0].name : `${files.length} documents`
    );

    // Check for large files that may result in truncation
    const largeFiles = files.filter(f => f.size > LARGE_DOCUMENT_THRESHOLD);
    if (largeFiles.length > 0) {
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(1);
      const largeFileNames = largeFiles.map(f => f.name).join(', ');

      toast(
        `Large document${largeFiles.length > 1 ? 's' : ''} detected (${totalSizeMB}MB total). In-context text may be truncated to ${(MAX_EXTRACTED_TEXT_CHARS / 1000).toFixed(0)}K chars. Full documents will still be indexed for RAG search.`,
        { duration: 5000, icon: 'ℹ️' }
      );
    }

    try {
      // Upload all documents with progress tracking
      for (let i = 0; i < files.length; i++) {
        // Check if cancelled
        if (controller.signal.aborted) {
          throw new Error('Upload cancelled');
        }

        const file = files[i];
        if (isDocumentFile(file)) {
          const reader = new FileReader();
          const base64String = await new Promise<string>((resolve, reject) => {
            reader.onload = (e: ProgressEvent<FileReader>) => {
              const result = e.target?.result;
              if (typeof result === 'string') {
                resolve(result);
              } else {
                reject(new Error('Failed to read file'));
              }
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          const documentReference = await uploadDocument(base64String, file.name, file.type);
          newDocumentRefs.push({ ...documentReference, filename: file.name });

          // Update progress
          updateUploadProgress(uploadId, Math.round(((i + 1) / files.length) * 100));
        }
      }

      if (newDocumentRefs.length > 0) {
        setDocumentRefs(newDocumentRefs);
        setInputFile(newDocumentRefs.length === 1 ? newDocumentRefs[0].filename || 'document' : `${newDocumentRefs.length} documents selected`);
        const fallbackExtension = newDocumentRefs.length === 1 && newDocumentRefs[0].filename
          ? getFileExtension(newDocumentRefs[0].filename)
          : '';
        setInputFileExtension(fallbackExtension || 'doc');
      }

      // Complete the tracked upload
      completeTrackedUpload(uploadId);
    } catch (error: any) {
      // Only show error if not cancelled
      if (error?.message !== 'Upload cancelled') {
        console.error('Error uploading documents:', error);
        alert('Failed to upload documents. Please try again.');
      }
      handleInputFileDelete();
      completeTrackedUpload(uploadId);
    } finally {
      setIsUploadingImage(false);
    }
  };

  const processMultipleImages = async (files: File[]) => {
    const newImageRefs: ImageReference[] = [];
    setIsUploadingImage(true);

    // Start tracked upload for cancellation support
    const { id: uploadId, controller } = startTrackedUpload(
      'image',
      files.length === 1 ? files[0].name : `${files.length} images`
    );

    try {
      // Upload all images with progress tracking
      for (let i = 0; i < files.length; i++) {
        // Check if cancelled
        if (controller.signal.aborted) {
          throw new Error('Upload cancelled');
        }

        const file = files[i];
        const reader = new FileReader();
        const fullBase64String = await new Promise<string>((resolve, reject) => {
          reader.onload = (e: ProgressEvent<FileReader>) => {
            const result = e.target?.result;
            if (typeof result === 'string') {
              resolve(result);
            } else {
              reject(new Error('Failed to read file'));
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        let imageToUpload = fullBase64String;

        // Check if compression is needed
        const base64WithoutPrefix = imageToUpload.replace(/^data:image\/[a-z]+;base64,/, '');
        const sizeInKB = (base64WithoutPrefix.length * 3 / 4) / 1024;
        const shouldCompress = sizeInKB > UPLOAD_LIMITS.IMAGE_COMPRESSION_THRESHOLD_KB;

        if (shouldCompress) {
          imageToUpload = await compressImageWithTimeout(imageToUpload, file.type, true);
        }

        // Upload image to Redis and get reference
        const imgRef = await uploadImage(imageToUpload, file.type);
        newImageRefs.push(imgRef);

        // Update progress
        updateUploadProgress(uploadId, Math.round(((i + 1) / files.length) * 100));
      }

      if (newImageRefs.length > 0) {
        setImageRefs(newImageRefs);
        setInputFile(`${newImageRefs.length} images selected`);
        const extension = files[0].name.split('.').pop() ?? 'jpg';
        setInputFileExtension(extension.toLowerCase());
      }

      // Complete the tracked upload
      completeTrackedUpload(uploadId);
    } catch (error: any) {
      // Only show error if not cancelled
      if (error?.message !== 'Upload cancelled') {
        console.error('Error uploading images:', error);
        alert('Failed to upload images. Please try again.');
      }
      handleInputFileDelete();
      completeTrackedUpload(uploadId);
    } finally {
      setIsUploadingImage(false);
    }
  };

  const processVideoFile = async (file: File) => {
    setIsUploadingVideo(true);

    // Start tracked upload for cancellation support
    const { id: uploadId, controller } = startTrackedUpload('video', file.name);

    try {
      const reader = new FileReader();
      const fullBase64String = await new Promise<string>((resolve, reject) => {
        // Check if cancelled before starting
        if (controller.signal.aborted) {
          reject(new Error('Upload cancelled'));
          return;
        }

        reader.onload = (e: ProgressEvent<FileReader>) => {
          const result = e.target?.result;
          if (typeof result === 'string') {
            resolve(result);
          } else {
            reject(new Error('Failed to read video file'));
          }
        };
        reader.onerror = reject;

        // Track read progress
        reader.onprogress = (e: ProgressEvent<FileReader>) => {
          if (e.lengthComputable) {
            updateUploadProgress(uploadId, Math.round((e.loaded / e.total) * 50)); // First 50% is reading
          }
        };

        reader.readAsDataURL(file);
      });

      // Check if cancelled after reading
      if (controller.signal.aborted) {
        throw new Error('Upload cancelled');
      }

      const mimeType = getVideoMimeType(file);

      // Upload video to Redis and get reference (second 50% is uploading)
      updateUploadProgress(uploadId, 75);
      const vidRef = await uploadVideo(fullBase64String, file.name, mimeType);
      updateUploadProgress(uploadId, 100);

      setVideoRef(vidRef);
      setInputFile(file.name);
      const extension = file.name.split('.').pop() ?? 'mp4';
      setInputFileExtension(extension.toLowerCase());

      // Complete the tracked upload
      completeTrackedUpload(uploadId);
      toast.success('Video uploaded successfully');
    } catch (error: any) {
      // Only show error if not cancelled
      if (error?.message !== 'Upload cancelled') {
        console.error('Error uploading video:', error);
        const errorMsg = error instanceof Error ? error.message : 'Failed to upload video';
        alert(errorMsg);
      }
      handleInputFileDelete();
      completeTrackedUpload(uploadId);
    } finally {
      setIsUploadingVideo(false);
    }
  };

  const processTranscriptFile = async (file: File) => {
    try {
      const reader = new FileReader();
      const textContent = await new Promise<string>((resolve, reject) => {
        reader.onload = (e: ProgressEvent<FileReader>) => {
          const result = e.target?.result;
          if (typeof result === 'string') {
            resolve(result);
          } else {
            reject(new Error('Failed to read transcript file'));
          }
        };
        reader.onerror = reject;
        reader.readAsText(file);
      });

      if (!textContent.trim()) {
        toast.error('Transcript file is empty');
        return;
      }

      // Store transcript content for sending with message
      setTranscriptContent({
        filename: file.name,
        content: textContent
      });
      setInputFile(file.name);
      const extension = file.name.split('.').pop() ?? 'vtt';
      setInputFileExtension(extension.toLowerCase());

      toast.success(`Transcript "${file.name}" loaded. Send a message to process it.`);
    } catch (error) {
      console.error('Error reading transcript file:', error);
      toast.error('Failed to read transcript file');
      handleInputFileDelete();
    }
  };

  async function processDocumentInBackground(documentRefsData: Array<{ documentId: string; sessionId: string; filename?: string }>, filenameDisplay: string) {
    // Capture the conversation ID at the START of processing
    // This ensures we update the correct conversation even if user switches during processing
    const targetConversationId = selectedConversationRef.current?.id;

    if (!targetConversationId) {
      toast.error('No conversation selected for document upload.');
      return false;
    }

    // Create AbortController for this upload and track it
    const abortController = new AbortController();
    pendingDocumentUploadsRef.current.set(targetConversationId, abortController);
    setIsProcessingDocument(true);

    try {
      const username = user?.username || 'anon';
      const targetCollection = (typeof selectedCollection === 'string' && selectedCollection) ? selectedCollection : username;
      const documentCount = documentRefsData.length;

      // Construct the same chat message that triggers document processing via the backend
      const messageContent = documentCount === 1
        ? `Process the document "${filenameDisplay}" using nv_ingest_postprocessing_tool with documentRef=${JSON.stringify(documentRefsData[0])}, username="${username}", and collection_name="${targetCollection}".`
        : `Process ${documentCount} documents using nv_ingest_postprocessing_tool with documentRefs=${JSON.stringify(documentRefsData)}, username="${username}", and collection_name="${targetCollection}".`;

      // Submit as an async job — returns immediately with a jobId.
      // The server-side processJobAsync handles the long-running backend call.
      const submitResponse = await fetch('/api/chat/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: messageContent }],
          chatCompletionURL: '',
          additionalProps: {
            username,
            enableIntermediateSteps: false,
            isDocumentProcessing: true,
          },
          userId: username,
        }),
        signal: abortController.signal,
      });

      if (!submitResponse.ok) {
        const errBody = await submitResponse.text().catch(() => '');
        logger.error('Failed to submit document processing job', { status: submitResponse.status, body: errBody });
        toast.error('Failed to start document processing. Please try again.');
        return false;
      }

      const { jobId } = await submitResponse.json();
      logger.info('Document processing async job submitted', { jobId, documentCount, targetCollection });

      // Poll for completion using short GET requests (never timeout through proxy chain)
      const POLL_INTERVAL_MS = 3000;
      const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 minutes max
      const startTime = Date.now();

      let fullResponse = '';
      while (true) {
        if (abortController.signal.aborted) {
          // Try to cancel the server-side job
          await fetch(`/api/chat/async?jobId=${jobId}`, { method: 'DELETE' }).catch(() => {});
          logger.info('Document processing aborted by user', { jobId });
          return false;
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

        if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
          toast.error(
            'Document processing timed out. The document may be too large or the backend is under heavy load.',
            { duration: 8000 },
          );
          await fetch(`/api/chat/async?jobId=${jobId}`, { method: 'DELETE' }).catch(() => {});
          return false;
        }

        const statusResponse = await fetch(`/api/chat/async?jobId=${jobId}`, {
          signal: abortController.signal,
        });

        if (!statusResponse.ok) {
          if (statusResponse.status === 404) {
            logger.error('Document processing job not found', { jobId });
            toast.error('Document processing job was lost. Please try again.');
            return false;
          }
          logger.warn('Failed to poll document job status', { status: statusResponse.status });
          continue; // Retry on transient errors
        }

        const status = await statusResponse.json();

        if (status.status === 'error') {
          logger.error('Document processing job failed', { jobId, error: status.error });
          toast.error(status.error || 'Document processing failed. Please try again.');
          return false;
        }

        if (status.status === 'completed' && (status.finalizedAt || status.fullResponse)) {
          fullResponse = status.fullResponse || '';
          logger.info('Document processing job completed', { jobId, responseLength: fullResponse.length });
          break;
        }

        // Still pending/streaming — continue polling
        logger.debug('Document processing still in progress', { jobId, status: status.status, progress: status.progress });
      }

      // Extract text from the async job response (same logic as before)
      const collectionUsed = targetCollection;
      logger.info('Documents processed successfully via async job', { jobId, responseLength: fullResponse.length });

      // Find the target conversation from the latest state using the captured ID
      const latestConversations = conversationsRef.current;
      const targetConversation = latestConversations.find(
        (conv: Conversation) => conv.id === targetConversationId
      );

      // Extract text from the async job's fullResponse
      const extractedResult = extractTextFromUnknown(fullResponse);
      const extractedText = extractedResult?.text || null;

      logger.debug('Extraction result', {
        extractedTextExists: !!extractedText,
        extractedTextLength: extractedText?.length || 0,
      });

      // Show truncation warning if document was truncated
      if (extractedResult?.wasTruncated) {
        toast(
          `Document truncated: ${extractedResult.truncatedPercent}% omitted (${extractedResult.originalLength.toLocaleString()} → ${extractedResult.truncatedLength.toLocaleString()} chars, ~${extractedResult.estimatedTokens.toLocaleString()} tokens). Use RAG search for full document queries.`,
          { duration: 6000, icon: '⚠️' }
        );
      } else if (extractedResult && extractedResult.estimatedTokens > MODEL_CONTEXT_WARNING_TOKENS) {
        toast(
          `Large document in context: ~${extractedResult.estimatedTokens.toLocaleString()} tokens. This may impact response quality for complex queries.`,
          { duration: 5000, icon: 'ℹ️' }
        );
      }

      const successMsg = documentCount === 1
        ? `Document uploaded to collection "${collectionUsed}"`
        : `${documentCount} documents uploaded to collection "${collectionUsed}"`;
      toast.success(successMsg);

      if (targetConversation && targetConversationId) {
        const newMessages: Message[] = [];

        // Add a system message confirming upload
        const confirmationMessage = documentCount === 1
          ? `Document "${filenameDisplay}" uploaded to collection "${collectionUsed}".`
          : `${documentCount} documents uploaded to collection "${collectionUsed}".`;

        newMessages.push({
          id: uuidv4(),
          role: 'system',
          content: confirmationMessage
        });

        if (extractedText) {
          const docInfo = extractedResult?.wasTruncated
            ? `(truncated: ${extractedResult.truncatedLength.toLocaleString()} of ${extractedResult.originalLength.toLocaleString()} chars)`
            : `(${extractedText.length.toLocaleString()} chars)`;

          const documentHeader = documentCount === 1
            ? `[DOCUMENT CONTENT: "${filenameDisplay}" ${docInfo}]`
            : `[DOCUMENT CONTENT: First of ${documentCount} documents - "${documentRefsData[0]?.filename || 'document'}" ${docInfo}]`;

          newMessages.push({
            id: uuidv4(),
            role: 'user',
            content: `I've uploaded ${documentCount === 1 ? 'a document' : `${documentCount} documents`} for reference. Here is the extracted text content:\n\n${DOCUMENT_EXTRACT_START}\n${extractedText}\n${DOCUMENT_EXTRACT_END}`
          });

          logger.debug('Document User Message Created', {
            documentHeader,
            extractedTextLength: extractedText.length,
          });
        } else {
          // No inline text extracted — document was ingested into the vector store.
          // Add a visible assistant message so the user sees confirmation in the chat.
          logger.warn('No extracted text available — adding assistant confirmation message');
          const confirmNote = documentCount === 1
            ? `I've processed your document "${filenameDisplay}" and added it to the "${collectionUsed}" collection. You can now ask questions about it and I'll use RAG search to find relevant content.`
            : `I've processed ${documentCount} documents and added them to the "${collectionUsed}" collection. You can now ask questions about them and I'll use RAG search to find relevant content.`;
          newMessages.push({
            id: uuidv4(),
            role: 'assistant',
            content: confirmNote,
          });
        }

        const updatedConversation = {
          ...targetConversation,
          messages: [...targetConversation.messages, ...newMessages]
        };

        const updatedConversations = latestConversations.map((conv: Conversation) =>
          conv.id === targetConversationId ? updatedConversation : conv
        );

        homeDispatch({
          field: 'conversations',
          value: updatedConversations
        });

        const currentlySelectedId = selectedConversationRef.current?.id;
        if (currentlySelectedId === targetConversationId) {
          homeDispatch({
            field: 'selectedConversation',
            value: updatedConversation
          });
          logger.info('Document content added to UI', { conversationId: targetConversationId });
        } else {
          logger.info('Document content saved but not displayed (user viewing different conversation)', {
            targetConversationId,
            currentlySelectedId,
          });
          if (typeof window !== 'undefined') {
            sessionStorage.setItem(`pendingDocumentRefresh_${targetConversationId}`, 'true');
          }
        }

        try {
          await Promise.all([
            saveConversation(updatedConversation),
            saveConversations(updatedConversations)
          ]);
          logger.info('Document processing: Saved conversation to Redis', {
            targetConversationId,
            newMessagesCount: newMessages.length
          });
        } catch (saveError) {
          logger.error('Document processing: Failed to save conversation', saveError);
          toast.error('Document processed but failed to save. Please refresh to retry.');
        }
      }

      return true;
    } catch (error) {
      logger.error('Document Processing Error', {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
        targetConversationId,
        documentRefsCount: documentRefsData?.length || 0,
      });

      // Handle abort errors (user cancellation)
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.info('Document processing aborted by user', { conversationId: targetConversationId });
        return false;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Document processing aborted', { conversationId: targetConversationId });
        return false;
      }

      if (error instanceof TypeError && error.message.includes('fetch')) {
        toast.error('Network error while processing document. Check your connection and try again.');
      } else {
        toast.error('Error processing document. Please try again.');
      }

      return false;
    } finally {
      pendingDocumentUploadsRef.current.delete(targetConversationId);
      if (selectedConversationRef.current?.id === targetConversationId) {
        setIsProcessingDocument(false);
      }
    }
  }

  const handleStop = () => {
    // Call the parent's stop handler if provided (handles both streaming and async modes)
    if (onStop) {
      onStop();
    } else {
      // Fallback to direct controller abort for streaming mode
      if (controller.current) {
        controller.current.abort();
        controller.current = new AbortController();
        // Reset streaming state immediately for better UX
        if (selectedConversationId) {
          const nextStreamingMap = { ...streamingByConversationId };
          delete nextStreamingMap[selectedConversationId];
          homeDispatch({ field: 'streamingByConversationId', value: nextStreamingMap });
          homeDispatch({ field: 'messageIsStreaming', value: Object.keys(nextStreamingMap).length > 0 });
        } else {
          homeDispatch({ field: 'messageIsStreaming', value: false });
        }
        homeDispatch({ field: 'loading', value: false });
      }
    }
  };

  const handleSend = async () => {
    // Prevent sending while auth is loading to avoid race conditions
    if (!canSendMessage) {
      toast.error('Please wait for authentication to complete');
      return;
    }

    if (resolvedIsStreaming || isUploadingImage || isUploadingVideo || isProcessingDocument) {
      return;
    }

    if (!content && !inputFile && !imageRef && !videoRef && documentRefs.length === 0 && !transcriptContent) {
      alert(t('Please enter a message or attach a file'));
      return;
    }

    // Handle transcript files - inject content into message
    if (transcriptContent) {
      const transcriptMessage = content
        ? `${content}\n\n--- Transcript: ${transcriptContent.filename} ---\n${transcriptContent.content}`
        : `Please analyze this transcript and create meeting notes:\n\n--- Transcript: ${transcriptContent.filename} ---\n${transcriptContent.content}`;

      onSend({
        role: 'user',
        content: transcriptMessage,
        metadata: {
          useDeepThinker: useDeepThinker
        }
      });

      setContent('');
      setInputFile(null);
      setInputFileExtension('');
      setTranscriptContent(null);

      if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
        textareaRef.current.blur();
      }

      // Re-enable auto-scroll after sending message
      homeDispatch({ field: 'autoScroll', value: true });
      return;
    }

    // Process documents first if there are any
    if (documentRefs.length > 0) {
      // Show processing message
      const toastMsg = documentRefs.length === 1 ? 'Processing document...' : `Processing ${documentRefs.length} documents...`;
      toast.loading(toastMsg, { id: 'document-processing' });

      const success = await processDocumentInBackground(documentRefs, inputFile || 'documents');

      // Dismiss loading toast
      toast.dismiss('document-processing');

      if (!success) {
        // Don't send the message if document processing failed
        return;
      }

      // If there is no additional user text, do not send a follow-up chat message.
      // The background processor already injected a simple confirmation.
      if (!content && !imageRef) {
        setContent('');
        setInputFile(null);
        setInputFileExtension('');
        setInputFileContent('');
        setInputFileContentCompressed('');
        setImageRef(null);
        setDocumentRefs([]);
        setSelectedCollection('');
        if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
          textareaRef.current.blur();
        }
        return;
      }
    }

    // Store deep thinker mode in metadata instead of appending to content
    if (inputFile || imageRef || imageRefs.length > 0 || videoRef || videoRefs.length > 0 || documentRefs.length > 0) {
      const attachments = [];

      if (imageRef) {
        attachments.push({
          content: '', // Don't send base64 in the message
          type: 'image',
          imageRef: imageRef
        });
      }

      // Handle multiple images
      if (imageRefs.length > 0) {
        attachments.push({
          content: '', // Don't send base64 in the message
          type: 'image',
          imageRefs: imageRefs
        });
      }

      // Handle single video
      if (videoRef) {
        attachments.push({
          content: '', // Don't send base64 in the message
          type: 'video',
          videoRef: videoRef
        });
      }

      // Handle multiple videos (future support)
      if (videoRefs.length > 0) {
        attachments.push({
          content: '', // Don't send base64 in the message
          type: 'video',
          videoRefs: videoRefs
        });
      }

      // Don't include document in attachments since it's already processed
      // if (documentRef) {
      //   attachments.push({
      //     content: '', // Don't send base64 in the message
      //     type: 'document',
      //     documentRef: documentRef
      //   });
      // }

      // Send message with attachments (images and/or videos)
      onSend({
        role: 'user',
        content: content,
        metadata: {
          useDeepThinker: useDeepThinker
        },
        attachments: attachments.length > 0 ? attachments : undefined
      });
      setContent('');
      setInputFile(null);
      setInputFileExtension('');
      setInputFileContent('');
      setInputFileContentCompressed('');
      setImageRef(null);
      setImageRefs([]);
      setVideoRef(null);
      setVideoRefs([]);
      setDocumentRefs([]);
      setSelectedCollection('');
    }

    else {
      onSend({
        role: 'user',
        content: content,
        metadata: {
          useDeepThinker: useDeepThinker
        }
      });
      setContent('');
      setInputFile(null);
      setInputFileExtension('');
      setInputFileContent('');
      setInputFileContentCompressed('');
      setImageRef(null);
      setImageRefs([]);
      setVideoRef(null);
      setVideoRefs([]);
      setDocumentRefs([]);
      setSelectedCollection('');
    }


    if (window.innerWidth < 640 && textareaRef && textareaRef.current) {
      textareaRef.current.blur();
    }

    // Re-enable auto-scroll after sending message so user sees the response
    homeDispatch({ field: 'autoScroll', value: true });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !isTyping && !isMobile() && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === '/' && e.metaKey) {
      e.preventDefault();
    }
  };



  const isMobile = () => {
    if (typeof window === 'undefined') {
      return false;
    }

    return window.matchMedia('(pointer: coarse)').matches;
  };

  const processFile = async ({ fullBase64String, file }: { fullBase64String: string | ArrayBuffer | null, file: File }) => {
    if (!fullBase64String || typeof fullBase64String !== 'string') {
      alert('Invalid file data');
      return;
    }
    const [fileType] = file && file.type.split('/');
    const isDocument = isDocumentFile(file);
    const isVideo = isVideoFile(file);
    const isTranscript = isTranscriptFile(file);

    if (!isDocument && !isVideo && !isTranscript && !["image"].includes(fileType)) {
      alert('Supported file types: images, videos (MP4, FLV, 3GP), documents (PDF, DOCX, PPTX, HTML), and transcripts (VTT, SRT).');
      return;
    }

    // Handle transcript files separately
    if (isTranscript) {
      await processTranscriptFile(file);
      return;
    }

    // Handle video files separately
    if (isVideo) {
      const validation = validateVideoFile(file);
      if (!validation.valid) {
        alert(validation.error);
        return;
      }
      await processVideoFile(file);
      return;
    }

    // Validate file size using centralized limits (accounts for base64 overhead)
    const maxSize = isDocument ? UPLOAD_LIMITS.DOCUMENT_MAX_SIZE_BYTES : UPLOAD_LIMITS.IMAGE_MAX_SIZE_BYTES;
    if (file && file.size > maxSize) {
      alert(`File size (${formatFileSize(file.size)}) exceeds maximum allowed size (${formatFileSize(maxSize)})`);
      return;
    }

    setIsUploadingImage(true);

    try {
      if (isDocument) {
        // Warn about large documents that may be truncated
        if (file.size > LARGE_DOCUMENT_THRESHOLD) {
          const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
          toast(
            `Large document (${fileSizeMB}MB). In-context text may be truncated to ${(MAX_EXTRACTED_TEXT_CHARS / 1000).toFixed(0)}K chars. Full document will still be indexed for RAG search.`,
            { duration: 5000, icon: 'ℹ️' }
          );
        }

        // Handle document upload
        const documentReference = await uploadDocument(fullBase64String, file.name, file.type);
        setDocumentRefs([{ ...documentReference, filename: file.name }]);
        setInputFile(file.name);
        setInputFileExtension(getFileExtension(file.name) || 'doc');
      } else {
        // Handle image upload
        let imageToUpload = fullBase64String;

        // Check if compression is needed
        const base64WithoutPrefix = imageToUpload.replace(/^data:image\/[a-z]+;base64,/, '');
        const sizeInKB = (base64WithoutPrefix.length * 3 / 4) / 1024;
        const shouldCompress = sizeInKB > UPLOAD_LIMITS.IMAGE_COMPRESSION_THRESHOLD_KB;

        if (shouldCompress) {
          const compressedBase64 = await compressImageWithTimeout(imageToUpload, file.type, true);
          imageToUpload = compressedBase64;
          setInputFileContentCompressed(compressedBase64);
        } else {
          setInputFileContentCompressed(imageToUpload);
        }

        // Upload image to Redis and get reference
        const imgRef = await uploadImage(imageToUpload, file.type);
        setImageRef(imgRef);
        setInputFile(file.name);
        const extension = file.name.split('.').pop() ?? 'jpg';
        setInputFileExtension(extension.toLowerCase());
      }

      // Clear the base64 content to save memory
      setInputFileContent('');
    } catch (error) {
      console.error('Error processing image:', error);
      alert('Failed to upload image. Please try again.');
      handleInputFileDelete();
    } finally {
      setIsUploadingImage(false);
    }
  }



  const parseVariables = (content: string) => {
    const regex = /{{(.*?)}}/g;
    const foundVariables = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      foundVariables.push(match[1]);
    }

    return foundVariables;
  };


  // Drag-and-drop visual indicator handlers (wrapper level)
  const handleWrapperDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const handleWrapperDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleWrapperDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleWrapperDrop = useCallback((e: React.DragEvent) => {
    dragCounterRef.current = 0;
    setIsDragging(false);
  }, []);

  // Additional handlers for drag and drop
  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault(); // Necessary to allow the drop event
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // Check if all files are documents, images, videos, or transcripts (don't mix types)
      const fileTypes = Array.from(files).map((f: File) => {
        if (isTranscriptFile(f)) return 'transcript';
        if (isDocumentFile(f)) return 'document';
        if (isVideoFile(f)) return 'video';
        return 'image';
      });
      const allDocuments = fileTypes.every(type => type === 'document');
      const allImages = fileTypes.every(type => type === 'image');
      const allVideos = fileTypes.every(type => type === 'video');
      const allTranscripts = fileTypes.every(type => type === 'transcript');

      if (!allDocuments && !allImages && !allVideos && !allTranscripts) {
        alert('Please drop files of the same type (documents, images, videos, or transcripts).');
        return;
      }

      if (allTranscripts) {
        // Only allow one transcript at a time
        if (files.length > 1) {
          alert('Please drop only one transcript file at a time.');
          return;
        }
        const file = files[0];
        if (file.size > UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_BYTES) {
          alert(`Transcript file is too large. Maximum size is ${UPLOAD_LIMITS.TRANSCRIPT_MAX_SIZE_MB}MB.`);
          return;
        }
        processTranscriptFile(file);
      } else if (allDocuments && files.length > 1) {
        // Check if too many documents are selected
        if (files.length > UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH) {
          alert(`Too many documents selected (${files.length}). Please select no more than ${UPLOAD_LIMITS.MAX_DOCUMENTS_PER_BATCH} documents at a time to avoid processing timeouts.`);
          return;
        }
        // Process multiple documents
        processMultipleFiles(Array.from(files));
      } else if (allVideos) {
        // Only allow one video at a time
        if (files.length > UPLOAD_LIMITS.MAX_VIDEOS_PER_BATCH) {
          alert(`Please drop only ${UPLOAD_LIMITS.MAX_VIDEOS_PER_BATCH} video at a time.`);
          return;
        }
        const file = files[0];
        const validation = validateVideoFile(file);
        if (!validation.valid) {
          alert(validation.error);
          return;
        }
        processVideoFile(file);
      } else {
        // For single file or images, use existing logic
        const file = files[0];
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
          const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
          processFile({ fullBase64String, file });
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardData = event.clipboardData;
    let items = clipboardData.items;
    let isImagePasted = false;

    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf("image") === 0) {
          isImagePasted = true;
          const file = item.getAsFile();
          if (file) {
            // Reading the image as Data URL (base64)
            const reader = new FileReader();
            reader.onload = (loadEvent) => {
              const fullBase64String = (loadEvent.target?.result ?? null) as string | ArrayBuffer | null;
              processFile({ fullBase64String, file });
            };
            reader.readAsDataURL(file);
          }
          break; // Stop checking after finding image, preventing any text setting
        }
      }
    }

    // Handle text only if no image was pasted
    if (!isImagePasted) {
      let text = clipboardData.getData('text/plain');
      if (text) {
        // setContent(text); // Set text content only if text is pasted
      }
    }
  };

  useEffect(() => {
    if (textareaRef && textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${textareaRef.current?.scrollHeight}px`;
      textareaRef.current.style.overflow = `${textareaRef?.current?.scrollHeight > 400 ? 'auto' : 'hidden'}`;
    }
  }, [content, textareaRef]);

  // Register quick action handlers with parent if requested
  useEffect(() => {
    if (!onQuickActionsRegister) return;
    onQuickActionsRegister({
      onAttachFile: triggerFileUpload,
      onTakePhoto: triggerPhotoUpload,
      onToggleDeepThought: handleToggleDeepThinker,
    });
  }, [onQuickActionsRegister, triggerFileUpload, triggerPhotoUpload, handleToggleDeepThinker]);

  // Track the previous conversation ID to detect changes
  const prevConversationIdRef = useRef(selectedConversationId);

  // CRITICAL: Reset all local state when conversation changes
  // This prevents state leakage between conversations (upload popups, content, etc.)
  useEffect(() => {
    const prevConversationId = prevConversationIdRef.current;
    prevConversationIdRef.current = selectedConversationId;

    // Only reset if conversation actually changed
    if (prevConversationId === selectedConversationId) {
      return;
    }

    // Check if there's a pending upload for the OLD conversation
    // If so, let it continue in the background (it will save to Redis when done)
    if (prevConversationId && pendingDocumentUploadsRef.current.has(prevConversationId)) {
      logger.info('Navigating away from conversation with pending document upload', { conversationId: prevConversationId });
      // Don't abort - let it complete and save to Redis
      // The upload will update the correct conversation via conversationsRef
    }

    // Reset all input state when switching conversations
    setContent('');
    setInputFile(null);
    setInputFileExtension('');
    setInputFileContent('');
    setInputFileContentCompressed('');
    setImageRef(null);
    setImageRefs([]);
    setVideoRef(null);
    setVideoRefs([]);
    setDocumentRefs([]);
    setTranscriptContent(null);
    setSelectedCollection('');
    setIsUploadingImage(false);
    setIsUploadingVideo(false);

    // Check if the NEW conversation has a pending upload
    if (selectedConversationId && pendingDocumentUploadsRef.current.has(selectedConversationId)) {
      setIsProcessingDocument(true);
    } else {
      setIsProcessingDocument(false);
    }
  }, [selectedConversationId]); // Only reset when conversation ID changes

  // Check for pending document refreshes when conversation changes
  useEffect(() => {
    if (!selectedConversationId) {
      setHasPendingDocumentRefresh(false);
      return;
    }

    // Check if this conversation has pending document content
    const pendingRefreshKey = `pendingDocumentRefresh_${selectedConversationId}`;
    const hasPendingRefresh = sessionStorage.getItem(pendingRefreshKey) === 'true';

    // Check if the conversation is out of sync with the list
    const needsSync = checkConversationSync(selectedConversationId);

    if (hasPendingRefresh || needsSync) {
      setHasPendingDocumentRefresh(true);
      setLastProcessedConversationId(selectedConversationId);

      // Clear the session storage flag since we're now aware of it
      if (hasPendingRefresh) {
        sessionStorage.removeItem(pendingRefreshKey);
      }

      logger.debug('Detected conversation needs refresh', {
        selectedConversationId,
        hasPendingRefresh,
        needsSync
      });
    } else {
      setHasPendingDocumentRefresh(false);
    }
  }, [selectedConversationId, checkConversationSync]);


  // Cleanup: Abort all pending uploads on component unmount
  useEffect(() => {
    return () => {
      // On unmount, abort all pending uploads
      pendingDocumentUploadsRef.current.forEach((controller, conversationId) => {
        logger.info('Aborting pending document upload on unmount', { conversationId });
        controller.abort();
      });
      pendingDocumentUploadsRef.current.clear();
    };
  }, []);

  // Use a ref to maintain stable positioning
  const inputContainerRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div
        ref={inputContainerRef}
        className="w-full"
        data-chat-input
        style={{
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflowX: 'hidden',
          overflowY: 'visible',
          // Prevent iOS keyboard push behavior
          WebkitTransform: 'translateZ(0)',
          transform: 'translateZ(0)',
        }}
      >
        <div className="flex w-full flex-col" style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
          {/* Document Processing Status Indicators */}
          {hasPendingDocumentRefresh && (
            <div className="w-full mb-2 px-4">
              <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 text-sm">
                <div className="flex items-center space-x-2">
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                  <span className="text-blue-700 dark:text-blue-300">
                    Document content was processed while you were away. Click refresh to view it.
                  </span>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => {
                      // Refresh selectedConversation from conversations list
                      if (selectedConversationId && refreshConversationFromList(selectedConversationId)) {
                        setHasPendingDocumentRefresh(false);
                        logger.info('Manually refreshed conversation with pending document content');
                      }
                    }}
                    className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 font-medium"
                  >
                    Refresh
                  </button>
                  <button
                    onClick={() => setHasPendingDocumentRefresh(false)}
                    className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 ml-2"
                    title="Dismiss"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          )}

          {isProcessingDocument && (
            <div className="w-full mb-2 px-4">
              <div className="flex items-center bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 text-sm">
                <div className="flex items-center space-x-2">
                  <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-amber-700 dark:text-amber-300">
                    Processing document... This may take a few moments.
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Authentication Status Indicator */}
          {!authLoading && !isAuthenticated && (
            <div className="w-full mb-2 px-4">
              <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm">
                <div className="flex items-center space-x-2">
                  <span className="text-gray-600 dark:text-gray-400">
                    Sign in to enable personalization and memory features
                  </span>
                </div>
                <a
                  href="/login"
                  className="text-nvidia-green hover:text-nvidia-green/80 font-medium"
                >
                  Sign in
                </a>
              </div>
            </div>
          )}
          {/* Agent working indicator — fixed above input, always visible during streaming */}
          {resolvedIsStreaming && (
            <div className="w-full mb-2 px-4 animate-morph-in">
              <div className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                useDeepThinker
                  ? 'bg-nvidia-purple/5'
                  : 'bg-nvidia-green/5'
              }`}>
                {/* Sweeping bar */}
                <div className="agent-heartbeat-bar flex-1 !max-w-none" data-deep-thinker={useDeepThinker} />

                {/* Breathing dot + label */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`heartbeat-dot w-2 h-2 rounded-full flex-shrink-0 ${
                    useDeepThinker ? 'bg-nvidia-purple' : 'bg-nvidia-green'
                  }`} />
                  <span className={`text-xs font-medium whitespace-nowrap ${
                    useDeepThinker ? 'text-nvidia-purple/70' : 'text-nvidia-green/70'
                  }`}>
                    Agent is working…
                  </span>
                </div>

                {/* Elapsed timer */}
                <span className={`text-[11px] tabular-nums flex-shrink-0 ${
                  useDeepThinker ? 'text-nvidia-purple/40' : 'text-nvidia-green/40'
                }`}>
                  {streamingElapsed < 60
                    ? `${streamingElapsed}s`
                    : `${Math.floor(streamingElapsed / 60)}m ${(streamingElapsed % 60).toString().padStart(2, '0')}s`}
                </span>
              </div>
            </div>
          )}

          {/* Input Container - minimal padding on mobile */}
          <div className="w-full" style={{ width: '100%', maxWidth: '100%', minWidth: 0, padding: '2px 4px', overflow: 'visible' }}>
            <div className="relative" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflow: 'visible' }}>
              {/* Main input wrapper - lighter glass on mobile (handled by CSS media query) */}
              <div
                className={`relative flex flex-col items-stretch w-full rounded-2xl liquid-glass-control-mobile ${
                  isDragging
                    ? 'border-2 border-dashed border-nvidia-green bg-nvidia-green/5'
                    : resolvedIsStreaming
                    ? `ring-1 ${useDeepThinker ? 'ring-nvidia-purple/30' : 'ring-nvidia-green/30'} animate-pulse`
                    : ''
                }`}
                style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '100%', minWidth: 0 }}
                onDragEnter={appConfig?.fileUploadEnabled ? handleWrapperDragEnter : undefined}
                onDragLeave={appConfig?.fileUploadEnabled ? handleWrapperDragLeave : undefined}
                onDragOver={appConfig?.fileUploadEnabled ? handleWrapperDragOver : undefined}
                onDrop={appConfig?.fileUploadEnabled ? handleWrapperDrop : undefined}
              >
                {isDragging && (
                  <div className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-nvidia-green/10 backdrop-blur-sm pointer-events-none">
                    <span className="text-sm font-medium text-nvidia-green">Drop files here</span>
                  </div>
                )}
                <div className="flex items-end w-full">

                {/* Quick Actions Button - Flex Item */}
                <div className="flex-shrink-0 pl-2 pb-2 z-20 flex items-center">
                  <QuickActionsPopup
                    onAttachFile={triggerFileUpload}
                    onTakePhoto={triggerPhotoUpload}
                    onToggleDeepThought={handleToggleDeepThinker}
                    isDeepThoughtEnabled={useDeepThinker}
                  />
                </div>

                {/* Text Input Area - Flex Grow */}
                <div className="relative flex-1 min-w-0 flex items-center">
                   {/* Deep Thinker Badge Indicator - positioned relative to text area or flex flow */}
                   {useDeepThinker && (
                    <div className="flex-shrink-0 mr-2 ml-1 hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-full bg-nvidia-purple/20 border border-nvidia-purple/40 backdrop-blur-sm whitespace-nowrap">
                      <IconBrain size={14} className="text-nvidia-purple" />
                      <span className="text-[10px] font-medium text-nvidia-purple tracking-wide uppercase">Deep Thinker</span>
                    </div>
                  )}

                  <textarea
                    ref={textareaRef}
                    className={`m-0 w-full resize-none bg-transparent py-4 px-2 text-[15px] leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-500 focus:outline-none dark:text-white dark:placeholder:text-white/40 transition-colors`}
                    style={{
                      resize: 'none',
                      minHeight: '54px',
                      maxHeight: '320px',
                      width: '100%',
                      overflow: `${textareaRef.current && textareaRef.current.scrollHeight > 400 ? 'auto' : 'hidden'}`,
                      overflowX: 'hidden', // Prevent horizontal scrolling in textarea
                      // iOS-specific fixes
                      WebkitAppearance: 'none',
                      WebkitTransform: 'translateZ(0)',
                      fontSize: '16px', // Prevents iOS zoom on focus
                    }}
                    placeholder={t('Type a message...') as unknown as string}
                    value={content}
                    rows={1}
                    aria-label="Message input"
                    aria-describedby={resolvedIsStreaming ? 'streaming-status' : undefined}
                    aria-disabled={!canSendMessage}
                    onCompositionStart={() => setIsTyping(true)}
                    onCompositionEnd={() => setIsTyping(false)}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    onFocus={(e) => {
                      if (onFocusChange) onFocusChange(true);
                      // Mobile keyboard handling for all devices
                      if (isMobile()) {
                        // In PWA standalone mode, visualViewport handles keyboard positioning
                        // Don't use scrollIntoView as it conflicts with the viewport adjustments
                        const isPWA = window.matchMedia('(display-mode: standalone)').matches ||
                                      (window.navigator as any).standalone === true;

                        if (isPWA) {
                          // In PWA mode, rely on visualViewport adjustments instead of scrollIntoView
                          return;
                        }

                        // Use Visual Viewport API for modern browsers (browser mode only)
                        // This keeps the input visible without jumping to the top
                        if (window.visualViewport) {
                          const handleResize = () => {
                            const inputRect = e.target.getBoundingClientRect();
                            const viewportHeight = window.visualViewport!.height;

                            // If input is covered by keyboard, scroll it into view at the bottom
                            // Use 'end' instead of 'center' to prevent jumping to top
                            if (inputRect.bottom > viewportHeight - 20) {
                              e.target.scrollIntoView({
                                behavior: 'smooth',
                                block: 'end',
                                inline: 'nearest'
                              });
                            }
                          };

                          // Listen for viewport resize (keyboard appearing)
                          window.visualViewport.addEventListener('resize', handleResize);

                          // Clean up listener after keyboard is shown
                          setTimeout(() => {
                            window.visualViewport?.removeEventListener('resize', handleResize);
                          }, 1000);
                        } else {
                          // Fallback for browsers without visualViewport API
                          // Use 'end' to keep input at bottom instead of jumping to center/top
                          setTimeout(() => {
                            e.target.scrollIntoView({
                              behavior: 'smooth',
                              block: 'end',
                              inline: 'nearest'
                            });
                          }, 300); // Wait for keyboard animation
                        }
                      }
                    }}
                    onBlur={() => {
                      if (onFocusChange) onFocusChange(false);
                    }}
                    {...(appConfig?.fileUploadEnabled && {
                      onDragOver: handleDragOver,
                      onDrop: handleDrop,
                        onPaste: handlePaste,
                      })}
                    />
                </div>

                {/* Send/Stop Button - Flex Item */}
                <div className="flex-shrink-0 pr-2 pb-2 z-20 flex items-center">
                  <button
                    className={`rounded-full p-2.5 text-white shadow-lg transition-all duration-250 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 ${
                      !canSendMessage
                        ? 'bg-gray-400 cursor-not-allowed'
                        : resolvedIsStreaming
                        ? 'bg-red-500 hover:bg-red-600 hover:shadow-[0_0_20px_rgba(239,68,68,0.4)]'
                        : isProcessingDocument
                        ? 'bg-amber-500 hover:bg-amber-600 hover:shadow-[0_0_20px_rgba(245,158,11,0.4)]'
                        : 'bg-nvidia-green hover:shadow-[0_0_25px_rgba(118,185,0,0.5)]'
                    }`}
                    onClick={resolvedIsStreaming ? handleStop : handleSend}
                    title={
                      !canSendMessage
                        ? 'Loading authentication...'
                        : resolvedIsStreaming
                        ? 'Stop generating'
                        : isProcessingDocument
                        ? 'Processing document...'
                        : 'Send message'
                    }
                    disabled={!canSendMessage || isProcessingDocument}
                  >
                    {!canSendMessage ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : resolvedIsStreaming ? (
                      <IconPlayerStopFilled size={18} />
                    ) : isProcessingDocument ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <IconSend size={18} />
                    )}
                  </button>
                </div>
                </div>

              {inputFile && (imageRef || imageRefs.length > 0 || videoRef || videoRefs.length > 0 || documentRefs.length > 0 || transcriptContent || inputFileContentCompressed) && (
                <div className="w-full border-t border-border-glass mt-2 animate-morph-in">
                  <div className="flex w-full flex-col gap-3 p-3 text-neutral-800 dark:text-white">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-1">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-nvidia-green/12 border border-nvidia-green/30 text-nvidia-green">
                          {transcriptContent ? <IconPaperclip size={16} /> : documentRefs.length > 0 ? <IconPaperclip size={16} /> : (videoRef || videoRefs.length > 0) ? <IconVideo size={16} /> : <IconPhoto size={16} />}
                        </span>
                        <div className="flex flex-col flex-1">
                          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-50">{inputFile}</span>
                          {(isUploadingImage || isUploadingVideo) && (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden max-w-[150px]">
                                <div
                                  className="h-full bg-nvidia-green transition-all duration-300"
                                  style={{
                                    width: `${Object.values(uploadProgress)[0] ?? 0}%`
                                  }}
                                />
                              </div>
                              <span className="text-xs text-nvidia-green animate-pulse">
                                {Object.values(uploadProgress)[0] ?? 0}%
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {/* Cancel button for active uploads */}
                        {hasActiveUploads && (
                          <button
                            type="button"
                            className="rounded-full p-2 text-amber-500 transition-all duration-250 hover:bg-amber-500/10 hover:scale-110 active:scale-95"
                            onClick={() => cancelAllUploads()}
                            aria-label="Cancel upload"
                            title="Cancel upload"
                          >
                            <IconX size={16} />
                          </button>
                        )}
                        {/* Delete button */}
                        <button
                          type="button"
                          className="rounded-full p-2 text-neutral-400 transition-all duration-250 hover:bg-red-500/10 hover:text-red-500 hover:scale-110 active:scale-95"
                          onClick={handleInputFileDelete}
                          aria-label="Remove attachment"
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    </div>

                    {imageRef && (
                      <div className="mx-auto w-full max-w-[240px] overflow-hidden rounded-xl">
                        <OptimizedImage imageRef={imageRef} alt={inputFile} className="rounded-xl" />
                      </div>
                    )}

                    {imageRefs.length > 0 && (
                      <div className="w-full">
                        <div className="text-center text-xs text-neutral-600 dark:text-neutral-300 mb-2">
                          {imageRefs.length} image{imageRefs.length > 1 ? 's' : ''} selected
                        </div>
                        <div className="grid grid-cols-3 gap-2 max-h-[240px] overflow-y-auto">
                          {imageRefs.map((imgRef, idx) => (
                            <div key={idx} className="aspect-square overflow-hidden rounded-lg border border-white/10">
                              <OptimizedImage imageRef={imgRef} alt={`Image ${idx + 1}`} className="w-full h-full object-cover" />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {videoRef && (
                      <div className="mx-auto w-full max-w-[320px] overflow-hidden rounded-xl">
                        <video
                          src={getVideoUrl(videoRef)}
                          controls
                          className="w-full rounded-xl border border-white/10"
                          preload="metadata"
                        >
                          Your browser does not support the video tag.
                        </video>
                        <div className="text-center text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                          Supported formats: MP4, FLV, 3GP
                        </div>
                      </div>
                    )}

                    {transcriptContent && (
                      <div className="px-3 py-2 space-y-2">
                        <div className="text-center text-xs text-neutral-600 dark:text-neutral-200">
                          Transcript ready to analyze
                        </div>
                        <div className="text-center text-xs text-neutral-500 dark:text-neutral-400">
                          Send a message to process this transcript into meeting notes
                        </div>
                        <div className="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-2 max-h-32 overflow-y-auto">
                          <pre className="text-xs text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap font-mono">
                            {transcriptContent.content.slice(0, 500)}
                            {transcriptContent.content.length > 500 && '...'}
                          </pre>
                        </div>
                        <div className="text-center text-xs text-neutral-400">
                          {(transcriptContent.content.length / 1024).toFixed(1)} KB
                        </div>
                      </div>
                    )}

                    {documentRefs.length > 0 && (
                      <>
                        <div className="px-3 py-2 space-y-1">
                          <div className="text-center text-xs text-neutral-600 dark:text-neutral-200">
                          {documentRefs.length === 1 ? 'Document ready to process' : `${documentRefs.length} documents ready to process`}
                          </div>
                          <div className="text-center text-xs text-neutral-500 dark:text-neutral-400">
                            Choose where to store {documentRefs.length === 1 ? 'this document' : 'these documents'} for future search
                          </div>
                        </div>
                        {documentRefs.length > 1 && (
                          <div className="px-3 py-1">
                            <div className="text-xs text-neutral-600 dark:text-neutral-300">
                              <div className="font-medium mb-1">Files selected:</div>
                              <ul className="max-h-24 overflow-y-auto space-y-0.5">
                                {documentRefs.map((doc: { documentId: string; sessionId: string; filename?: string }, idx: number) => (
                                  <li key={idx} className="truncate">• {doc.filename || `Document ${idx + 1}`}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                        <div className="px-3 pb-3" style={{ position: 'relative', zIndex: 10 }}>
                          <CollectionSelector
                            onSelect={setSelectedCollection}
                            selectedCollection={selectedCollection}
                            defaultCollection={user?.username || 'default'}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
              </div>
              {
                appConfig?.fileUploadEnabled &&
                <>
                  <input
                    key="document-file-input"
                    type="file"
                    ref={fileInputRef}
                    accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/html,text/vtt,.pdf,.docx,.pptx,.html,.htm,.vtt,.srt,video/mp4,video/x-flv,video/3gpp,.mp4,.flv,.3gp"
                    multiple={true}
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                  <input
                    key="photo-file-input"
                    type="file"
                    ref={photoInputRef}
                    accept="image/*,video/mp4,video/x-flv,video/3gpp,.mp4,.flv,.3gp"
                    multiple={true}
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                </>
              }
            </div>

          </div>
        </div>
      </div>
    </>
  );
};
