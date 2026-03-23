import {
  getInitials,
  escapeHtml,
  convertBackticksToPreCode,
  replaceMalformedMarkdownImages,
  replaceMalformedHTMLImages,
  replaceMalformedHTMLVideos,
  fixMalformedHtml,
  fetchLastMessage,
  delay,
} from '@/utils/app/helper';

import { describe, expect, it, vi } from 'vitest';

describe('getInitials', () => {
  it('should return initials for "John Doe"', () => {
    expect(getInitials('John Doe')).toBe('JD');
  });

  it('should return single initial for single name', () => {
    expect(getInitials('Alice')).toBe('A');
  });

  it('should return empty string for empty input', () => {
    expect(getInitials('')).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(getInitials(undefined)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('should escape ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('should escape less than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('should escape greater than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('should escape double quotes', () => {
    expect(escapeHtml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('should escape single quotes', () => {
    expect(escapeHtml("a 'b' c")).toBe('a &#39;b&#39; c');
  });

  it('should escape all entities together', () => {
    expect(escapeHtml('<div class="a">&</div>')).toBe(
      '&lt;div class=&quot;a&quot;&gt;&amp;&lt;/div&gt;',
    );
  });

  it('should return empty string for non-string input', () => {
    expect(escapeHtml(123 as any)).toBe('');
  });
});

describe('convertBackticksToPreCode', () => {
  it('should convert code blocks with language', () => {
    const input = '```javascript\nconsole.log("hi")\n```';
    const result = convertBackticksToPreCode(input);
    expect(result).toContain('<pre><code class="language-javascript">');
    expect(result).toContain('console.log(&quot;hi&quot;)');
  });

  it('should convert code blocks without language', () => {
    const input = '```\nhello\n```';
    const result = convertBackticksToPreCode(input);
    expect(result).toContain('<pre><code>hello</code></pre>');
  });

  it('should convert bold text', () => {
    const input = '**bold text**';
    expect(convertBackticksToPreCode(input)).toBe('<strong>bold text</strong>');
  });

  it('should return input for non-string input', () => {
    expect(convertBackticksToPreCode(42 as any)).toBe(42);
  });
});

describe('replaceMalformedMarkdownImages', () => {
  it('should replace incomplete markdown image at end of string', () => {
    const input = 'text ![alt](http://example.com/img';
    const result = replaceMalformedMarkdownImages(input);
    expect(result).toContain('<img src="loading"');
  });

  it('should leave complete markdown images unchanged', () => {
    const input = '![alt](http://example.com/img.png)';
    expect(replaceMalformedMarkdownImages(input)).toBe(input);
  });
});

describe('replaceMalformedHTMLImages', () => {
  it('should replace incomplete img tag at end of string', () => {
    const input = 'text <img src="http://example.com/img';
    const result = replaceMalformedHTMLImages(input);
    expect(result).toContain('<img src="loading"');
  });

  it('should leave complete img tags unchanged', () => {
    const input = '<img src="http://example.com/img.png" />';
    expect(replaceMalformedHTMLImages(input)).toBe(input);
  });
});

describe('replaceMalformedHTMLVideos', () => {
  it('should replace incomplete video tag at end of string', () => {
    const input = 'text <video src="http://example.com/vid';
    const result = replaceMalformedHTMLVideos(input);
    expect(result).toContain('<video controls');
  });

  it('should leave complete video tags unchanged', () => {
    const input = '<video controls><source src="vid.mp4" /></video>';
    expect(replaceMalformedHTMLVideos(input)).toBe(input);
  });
});

describe('fixMalformedHtml', () => {
  it('should fix malformed img tags', () => {
    const input = '<img src="test';
    const result = fixMalformedHtml(input);
    expect(result).toContain('<img src="loading"');
  });

  it('should fix malformed video tags', () => {
    const input = '<video src="test';
    const result = fixMalformedHtml(input);
    expect(result).toContain('<video controls');
  });

  it('should fix malformed markdown images', () => {
    const input = '![alt](http://example.com/img';
    const result = fixMalformedHtml(input);
    expect(result).toContain('<img src="loading"');
  });

  it('should return clean content unchanged', () => {
    const input = '<p>Hello world</p>';
    expect(fixMalformedHtml(input)).toBe(input);
  });
});

describe('fetchLastMessage', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'response' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'last response' },
  ];

  it('should find the last user message', () => {
    const result = fetchLastMessage({ messages, role: 'user' });
    expect(result?.content).toBe('second');
  });

  it('should find the last assistant message', () => {
    const result = fetchLastMessage({ messages, role: 'assistant' });
    expect(result?.content).toBe('last response');
  });

  it('should return null for empty array', () => {
    expect(fetchLastMessage({ messages: [] })).toBeNull();
  });

  it('should return null when no matching role', () => {
    expect(fetchLastMessage({ messages, role: 'system' })).toBeNull();
  });
});

describe('delay', () => {
  it('should return a promise that resolves', async () => {
    vi.useFakeTimers();
    const promise = delay(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
