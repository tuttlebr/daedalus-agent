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
                prevContentLength: prevProps.message.content?.length,
                nextContentLength: nextProps.message.content?.length,
                hasImages: nextProps.message.content?.includes('/api/session/imageStorage')
            });
        }

        return shouldRender;
    }
);
