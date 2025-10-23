import { FC, memo } from 'react';
import isEqual from 'lodash/isEqual';
import { ChatMessage, Props } from './ChatMessage';

export const MemoizedChatMessage: FC<Props> = memo(
    ChatMessage,
    (prevProps, nextProps) => {
        // componenent will render if new props are only different than previous props (to prevent unnecessary re-rendering)
        const shouldRender = isEqual(prevProps.message, nextProps.message);

        // Debug: log when content changes (especially for images)
        if (!shouldRender && prevProps.message.content !== nextProps.message.content) {
            console.log('MemoizedChatMessage: Content changed, will re-render', {
                messageId: nextProps.message.id,
                prevContentLength: prevProps.message.content?.length,
                nextContentLength: nextProps.message.content?.length,
                hasBase64Images: nextProps.message.content?.includes('data:image'),
                hasStoredImages: nextProps.message.content?.includes('/api/session/imageStorage'),
                contentPreview: nextProps.message.content?.substring(0, 100)
            });
        }

        return shouldRender;
    }
);
