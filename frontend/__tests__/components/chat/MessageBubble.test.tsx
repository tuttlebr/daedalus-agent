import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '@/components/chat/MessageBubble';

import { describe, expect, it } from 'vitest';

describe('error-only assistant messages', () => {
  it('renders error details and retry before any response token', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        messageIndex={1}
        onRetry={() => {}}
        message={{
          role: 'assistant',
          content: '',
          errorMessages: {
            message: 'Service unavailable',
            recoverable: true,
            timestamp: 1,
          },
        }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Service unavailable');
    expect(html).toContain('Retry');
  });

  it('still skips an empty placeholder without an error', () => {
    expect(
      renderToStaticMarkup(
        <MessageBubble
          messageIndex={1}
          message={{ role: 'assistant', content: '' }}
        />,
      ),
    ).toBe('');
  });
});
