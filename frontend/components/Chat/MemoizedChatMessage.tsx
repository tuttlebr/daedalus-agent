import { FC, memo, useMemo } from 'react';
import { ChatMessage, Props } from './ChatMessage';

// Create a simple hash function for content comparison
const hashContent = (content: string): number => {
    if (!content) return 0;
    let hash = 0;
    const len = Math.min(content.length, 1000); // Only hash first 1000 chars for performance
    for (let i = 0; i < len; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
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
