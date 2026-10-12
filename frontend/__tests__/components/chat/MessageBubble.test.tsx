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

describe('response generation duration', () => {
  it.each([
    [0, '&lt;1s'],
    [450, '&lt;1s'],
    [5500, '5s'],
    [125000, '2m 5s'],
    [3605000, '1h 0m 5s'],
  ])('renders %i ms beneath a completed answer', (duration, label) => {
    const html = renderToStaticMarkup(
      <MessageBubble
        messageIndex={1}
        message={{
          role: 'assistant',
          content: 'Completed answer',
          generationDurationMs: duration,
        }}
      />,
    );
    expect(html).toContain(`Generated in ${label}`);
    expect(html).toContain('including agent and tool work');
    expect(html.indexOf('<small')).toBeGreaterThan(
      html.indexOf('Completed answer'),
    );
  });

  it.each([undefined, -1, NaN, Infinity])(
    'omits an unavailable or invalid duration (%s)',
    (duration) => {
      const html = renderToStaticMarkup(
        <MessageBubble
          messageIndex={1}
          message={{
            role: 'assistant',
            content: 'Saved answer',
            generationDurationMs: duration,
          }}
        />,
      );
      expect(html).not.toContain('Generated in');
    },
  );

  it('waits until streaming finishes', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        messageIndex={1}
        isStreaming
        message={{
          role: 'assistant',
          content: 'Partial answer',
          generationDurationMs: 5000,
        }}
      />,
    );
    expect(html).not.toContain('Generated in');
  });
});
