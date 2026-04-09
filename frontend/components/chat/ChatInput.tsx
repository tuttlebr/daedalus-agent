'use client';

import React, { memo, useState, useRef, useCallback, useEffect } from 'react';
import classNames from 'classnames';
import { IconSend, IconSquare, IconPaperclip, IconBrain, IconX, IconPhoto, IconFileText, IconDatabase, IconNotes } from '@tabler/icons-react';
import toast from 'react-hot-toast';
import { IconButton } from '@/components/primitives';
import { Textarea } from '@/components/primitives';
import { DropZone } from '@/components/primitives';
import { ProgressBar } from '@/components/primitives';
import { GlassToolbar } from '@/components/surfaces';
import { useUISettingsStore } from '@/state';
import { Message } from '@/types/chat';
import { uploadImage, ImageReference } from '@/utils/app/imageHandler';
import { validateFileSize, formatFileSize } from '@/constants/uploadLimits';
import { uploadVTTFile, isVTTFile } from '@/utils/app/vttHandler';

type Attachment = NonNullable<Message['attachments']>[number];

interface UploadingFile {
  id: string;
  file: File;
  type: 'image' | 'document' | 'video' | 'transcript';
  progress: number;
  error?: string;
}

interface ChatInputProps {
  onSend: (message: Message) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

function classifyFile(file: File): 'image' | 'document' | 'video' | 'transcript' {
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

export const ChatInput = memo(({ onSend, onStop, isStreaming = false }: ChatInputProps) => {
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<string>('');
  const [collections, setCollections] = useState<string[]>([]);
  const [showCollections, setShowCollections] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const useDeepThinker = useUISettingsStore((s) => s.useDeepThinker);
  const toggleDeepThinker = useUISettingsStore((s) => s.toggleDeepThinker);

  const hasDocumentAttachment = attachments.some((a) => a.type === 'document');
  const isUploading = uploading.some((u) => u.progress < 100 && !u.error);
  const canSend = (content.trim() || attachments.length > 0) && !isStreaming && !isUploading;

  // Fetch Milvus collections on mount
  useEffect(() => {
    fetch('/api/milvus/collections')
      .then((r) => r.json())
      .then((data) => {
        if (data.collections) setCollections(data.collections);
      })
      .catch(() => {});
  }, []);

  // Show collection selector when documents are attached
  useEffect(() => {
    if (hasDocumentAttachment && !showCollections) {
      setShowCollections(true);
    } else if (!hasDocumentAttachment) {
      setShowCollections(false);
      setSelectedCollection('');
    }
  }, [hasDocumentAttachment, showCollections]);

  const uploadFile = useCallback(async (file: File) => {
    const type = classifyFile(file);
    const validation = validateFileSize(file, type);
    if (!validation.valid) {
      toast.error(validation.error || 'File too large');
      return;
    }

    const uploadId = `upload-${Date.now()}-${Math.random()}`;
    setUploading((prev) => [...prev, { id: uploadId, file, type, progress: 10 }]);

    try {
      // VTT/SRT files: upload as text via dedicated VTT storage (not base64)
      if (type === 'transcript') {
        setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: 30 } : u));
        const vttRef = await uploadVTTFile(file);
        setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: 100 } : u));

        const attachment: Attachment = {
          content: file.name,
          type: 'transcript',
          vttRef: { vttId: vttRef.vttId, sessionId: vttRef.sessionId, filename: file.name, mimeType: file.type || 'text/vtt' },
        };
        setAttachments((prev) => [...prev, attachment]);

        setTimeout(() => {
          setUploading((prev) => prev.filter((u) => u.id !== uploadId));
        }, 1000);
        return;
      }

      const base64 = await fileToBase64(file);
      setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: 50 } : u));

      if (type === 'image') {
        const imageRef = await uploadImage(base64, file.type);
        setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: 100 } : u));

        const attachment: Attachment = {
          content: file.name,
          type: 'image',
          imageRef: { imageId: imageRef.imageId, sessionId: imageRef.sessionId, mimeType: file.type },
        };
        setAttachments((prev) => [...prev, attachment]);

      } else if (type === 'document') {
        // Upload document to Redis storage
        const response = await fetch('/api/session/documentStorage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base64Data: base64,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });

        if (!response.ok) throw new Error('Document upload failed');
        const { documentId, sessionId } = await response.json();
        setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: 100 } : u));

        const attachment: Attachment = {
          content: file.name,
          type: 'document',
          documentRef: { documentId, sessionId, filename: file.name, mimeType: file.type },
        };
        setAttachments((prev) => [...prev, attachment]);

      } else if (type === 'video') {
        const response = await fetch('/api/session/videoStorage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base64Data: base64,
            filename: file.name,
            mimeType: file.type || 'video/mp4',
          }),
        });

        if (!response.ok) throw new Error('Video upload failed');
        const { videoId, sessionId } = await response.json();
        setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: 100 } : u));

        const attachment: Attachment = {
          content: file.name,
          type: 'video',
          videoRef: { videoId, sessionId, filename: file.name, mimeType: file.type },
        };
        setAttachments((prev) => [...prev, attachment]);
      }

      // Clear completed upload after a moment
      setTimeout(() => {
        setUploading((prev) => prev.filter((u) => u.id !== uploadId));
      }, 1000);

    } catch (err: any) {
      console.error('Upload failed:', err);
      toast.error(`Upload failed: ${err.message || 'Unknown error'}`);
      setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, error: err.message, progress: 0 } : u));
      setTimeout(() => {
        setUploading((prev) => prev.filter((u) => u.id !== uploadId));
      }, 3000);
    }
  }, []);

  const handleFileSelect = useCallback((files: File[]) => {
    for (const file of files) {
      uploadFile(file);
    }
  }, [uploadFile]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(() => {
    if (!canSend) return;

    // Build message content with routing hints for the backend
    let messageContent = content.trim();
    const messageAttachments = [...attachments];

    // Add routing metadata for document ingestion
    if (hasDocumentAttachment && selectedCollection) {
      const docNames = attachments.filter((a) => a.type === 'document').map((a) => a.content).join(', ');
      messageContent = messageContent || `Ingest the uploaded document(s) into the "${selectedCollection}" knowledge base.`;
      // Add collection context to message metadata
    }

    // Add routing hint for transcripts without text
    if (!messageContent && attachments.some((a) => a.type === 'transcript')) {
      messageContent = 'Summarize this meeting transcript and create structured notes.';
    }

    // Add routing hint for images without text
    if (!messageContent && attachments.some((a) => a.type === 'image')) {
      messageContent = 'Analyze this image and describe what you see.';
    }

    const message: Message = {
      role: 'user',
      content: messageContent,
      attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
      metadata: {
        ...(selectedCollection ? { targetCollection: selectedCollection } : {}),
      },
    };

    onSend(message);
    setContent('');
    setAttachments([]);
    setSelectedCollection('');
    setShowCollections(false);

    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [content, attachments, canSend, onSend, hasDocumentAttachment, selectedCollection]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Listen for bottom nav events
  useEffect(() => {
    const handleAttach = () => fileInputRef.current?.click();
    document.addEventListener('daedalus:attach-file', handleAttach);
    return () => document.removeEventListener('daedalus:attach-file', handleAttach);
  }, []);

  return (
    <GlassToolbar className="flex-shrink-0 px-4 py-3">
      <div className="max-w-3xl mx-auto space-y-2">
        <DropZone onDrop={handleFileSelect}>
          {/* Upload progress bars */}
          {uploading.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {uploading.map((u) => (
                <div key={u.id} className="flex items-center gap-2 text-xs">
                  {u.type === 'image' ? <IconPhoto size={14} className="text-nvidia-green" /> :
                   u.type === 'document' ? <IconFileText size={14} className="text-nvidia-blue" /> :
                   u.type === 'transcript' ? <IconNotes size={14} className="text-nvidia-yellow" /> :
                   <IconPhoto size={14} className="text-nvidia-purple" />}
                  <span className="text-dark-text-muted truncate flex-1">{u.file.name}</span>
                  {u.error ? (
                    <span className="text-nvidia-red">{u.error}</span>
                  ) : (
                    <div className="w-20">
                      <ProgressBar value={u.progress} size="sm" variant={u.progress === 100 ? 'success' : 'accent'} />
                    </div>
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
                    att.type === 'image' ? 'bg-nvidia-green/5 border-nvidia-green/20 text-nvidia-green' :
                    att.type === 'document' ? 'bg-nvidia-blue/5 border-nvidia-blue/20 text-nvidia-blue' :
                    att.type === 'transcript' ? 'bg-nvidia-yellow/5 border-nvidia-yellow/20 text-nvidia-yellow' :
                    'bg-nvidia-purple/5 border-nvidia-purple/20 text-nvidia-purple'
                  )}
                >
                  {att.type === 'image' ? <IconPhoto size={12} /> :
                   att.type === 'document' ? <IconFileText size={12} /> :
                   att.type === 'transcript' ? <IconNotes size={12} /> :
                   <IconPhoto size={12} />}
                  <span className="truncate max-w-[120px]">{att.content}</span>
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
          {showCollections && collections.length > 0 && (
            <div className="flex items-center gap-2 mb-2 px-1">
              <IconDatabase size={14} className="text-nvidia-blue flex-shrink-0" />
              <span className="text-xs text-dark-text-muted flex-shrink-0">Ingest to:</span>
              <select
                value={selectedCollection}
                onChange={(e) => setSelectedCollection(e.target.value)}
                className="flex-1 bg-dark-bg-tertiary text-dark-text-primary text-xs border border-white/10 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-nvidia-green/30"
              >
                <option value="">Select a knowledge base...</option>
                {collections.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
            </div>
          )}

          {/* Input row - attach/brain hidden on mobile (in BottomNav instead) */}
          <div className="flex items-end gap-2">
            <IconButton
              icon={<IconPaperclip />}
              aria-label="Attach file"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="hidden md:flex flex-shrink-0 mb-0.5"
            />

            <IconButton
              icon={<IconBrain />}
              aria-label={useDeepThinker ? 'Switch to Tool Calling' : 'Switch to Deep Thinker'}
              variant={useDeepThinker ? 'accent' : 'ghost'}
              size="sm"
              onClick={toggleDeepThinker}
              className={classNames(
                'hidden md:flex flex-shrink-0 mb-0.5',
                useDeepThinker && 'bg-nvidia-purple hover:bg-nvidia-purple-dark'
              )}
            />

            <div className="flex-1 min-w-0">
              <Textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={hasDocumentAttachment ? 'Add instructions or send to ingest...' :
                             attachments.some((a) => a.type === 'transcript') ? 'Ask about this transcript (e.g. "summarize this meeting")...' :
                             attachments.some((a) => a.type === 'image') ? 'Ask about this image...' :
                             'Send a message...'}
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
                size="sm"
                onClick={onStop}
                className="flex-shrink-0 mb-0.5"
              />
            ) : (
              <IconButton
                icon={<IconSend />}
                aria-label="Send message"
                variant={canSend ? 'accent' : 'ghost'}
                size="sm"
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
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/x-flv,video/3gpp,.pdf,.docx,.pptx,.html,.htm,.txt,text/vtt,.vtt,application/x-subrip,.srt"
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
});

ChatInput.displayName = 'ChatInput';
