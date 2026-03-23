import { FC, memo, useMemo } from 'react';
import { ChatMessage, Props } from './ChatMessage';

// Fast content fingerprint: hash first 500 + last 500 chars + length.
// This catches image-URL substitutions anywhere in the content without
// hashing multi-megabyte base64 strings.
const hashContent = (content: string): number => {
    if (!content) return 0;
    let hash = content.length;
    // Sample start
    const startLen = Math.min(content.length, 500);
    for (let i = 0; i < startLen; i++) {
        hash = ((hash << 5) - hash) + content.charCodeAt(i);
        hash = hash & hash;
    }
    // Sample end (if content is longer than 500 chars)
    if (content.length > 500) {
        const tailStart = Math.max(content.length - 500, 500);
        for (let i = tailStart; i < content.length; i++) {
            hash = ((hash << 5) - hash) + content.charCodeAt(i);
            hash = hash & hash;
        }
    }
    return hash;
};

export const MemoizedChatMessage: FC<Props> = memo(
    ChatMessage,
    (prevProps, nextProps) => {
        // Quick shallow comparison for most common changes
        if (prevProps.messageIndex !== nextProps.messageIndex) return false;

        const prevMsg = prevProps.message;
        const nextMsg = nextProps.message;

        // Check basic properties first (fastest)
        if (prevMsg.id !== nextMsg.id) return false;
        if (prevMsg.role !== nextMsg.role) return false;

        // Compare content using hash for performance
        const prevContentHash = hashContent(prevMsg.content);
        const nextContentHash = hashContent(nextMsg.content);
        if (prevContentHash !== nextContentHash) return false;

        // Compare intermediate steps count (avoid deep comparison)
        const prevStepsCount = prevMsg.intermediateSteps?.length || 0;
        const nextStepsCount = nextMsg.intermediateSteps?.length || 0;
        if (prevStepsCount !== nextStepsCount) return false;

        // Compare attachments count
        const prevAttachmentsCount = prevMsg.attachments?.length || 0;
        const nextAttachmentsCount = nextMsg.attachments?.length || 0;
        if (prevAttachmentsCount !== nextAttachmentsCount) return false;

        // If all shallow checks pass, consider them equal
        return true;
    }
);
