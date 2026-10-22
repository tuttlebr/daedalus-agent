import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ToolbarSlotProvider } from '@/components/layout/ToolbarSlot';
import { CodeBlock } from '@/components/markdown/CodeBlock';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ saveFile: vi.fn(), writeText: vi.fn() }));
vi.mock('@/hooks/useFileSave', () => ({
  useFileSave: () => ({ saveFile: mocks.saveFile, fileSaveDialog: null }),
}));

function readBlob(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

describe('code display and export preserve string content', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.clearAllMocks();
    mocks.writeText.mockResolvedValue(undefined);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    [JSON.stringify({ message: "It's ready", command: "echo 'hello'" }), true],
    ["{'message': 'leave this example intact'}", false],
  ])(
    'preserves JSON strings and unsupported examples: %s',
    async (value, valid) => {
      const expected = valid
        ? JSON.stringify(JSON.parse(value), null, 2)
        : value;
      act(() => root.render(<CodeBlock language="json" value={value} />));
      expect(container.querySelector('pre code')?.textContent).toBe(expected);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!
          .click();
      });
      expect(mocks.writeText).toHaveBeenCalledWith(expected);
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Download code"]')!
          .click();
      });
      expect(mocks.saveFile).toHaveBeenCalledTimes(1);
      expect(await readBlob(mocks.saveFile.mock.calls[0][0])).toBe(expected);
    },
  );

  it.each([
    ['json', '{"id": 12345678901234567890, "name": "snowflake"}'],
    ['json', '{"price": 1.50, "scale": 1e3}'],
    ['json', '{"text": "caf\\u00e9", "path": "a\\/b"}'],
    ['json', '{"key": 1, "key": 2}'],
    ['text', '9007199254740993'],
  ])(
    'never rewrites %s values that JSON cannot round-trip: %s',
    async (language, value) => {
      act(() => root.render(<CodeBlock language={language} value={value} />));
      expect(container.querySelector('pre code')?.textContent).toBe(value);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!
          .click();
      });
      expect(mocks.writeText).toHaveBeenCalledWith(value);
    },
  );

  it('still pretty-prints compact JSON whose values round-trip exactly', () => {
    const value = '{"a":[1,2.5,-3],"b":{"c":"two  spaces","d":null}}';
    act(() => root.render(<CodeBlock language="json" value={value} />));
    expect(container.querySelector('pre code')?.textContent).toBe(
      JSON.stringify(JSON.parse(value), null, 2),
    );
  });
});

describe('response documents', () => {
  let root: Root;
  let container: HTMLDivElement;
  let toolbar: HTMLDivElement;
  const html = '<p>Trip summary</p>';
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.clearAllMocks();
    mocks.writeText.mockResolvedValue(undefined);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } });
    container = document.body.appendChild(document.createElement('div'));
    toolbar = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
      root.unmount();
    });
    container.remove();
    toolbar.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('name themselves and hold every command in one header', () => {
    act(() =>
      root.render(
        <CodeBlock
          language="html"
          value={html}
          documentTitle="HTML Preview"
          actions={<button type="button" aria-label="View fullscreen" />}
        />,
      ),
    );
    const headers = container.querySelectorAll('.codeblock-document-header');
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toContain('HTML Preview');
    for (const name of ['Copy code', 'Download code', 'View fullscreen'])
      expect(headers[0].querySelector(`[aria-label="${name}"]`)).not.toBeNull();
    // The message frames the document; it has no card or language header.
    const frames = container.querySelectorAll('.codeblock');
    expect(frames).toHaveLength(1);
    expect(frames[0].classList).toContain('codeblock-document-frame');
    expect(frames[0].querySelector('iframe[title="HTML Preview"]')).not.toBe(
      null,
    );
  });

  it('move their commands into the fullscreen viewer toolbar', async () => {
    act(() =>
      root.render(
        <ToolbarSlotProvider value={toolbar}>
          <CodeBlock
            language="html"
            value={html}
            documentTitle="HTML Preview"
            fullscreen
          />
        </ToolbarSlotProvider>,
      ),
    );
    const group = toolbar.querySelector<HTMLElement>(
      '[role="group"][aria-label="Document commands"]',
    )!;
    expect(group.className).toContain('app-toolbar-group');
    expect(container.querySelector('.codeblock-document-header')).toBeNull();
    expect(container.querySelector('[aria-label="Copy code"]')).toBeNull();

    act(() =>
      group
        .querySelector<HTMLButtonElement>('[aria-label="Show code"]')!
        .click(),
    );
    expect(container.querySelector('pre code')?.textContent).toBe(html);
    expect(group.querySelector('[aria-label="Show preview"]')).not.toBeNull();
    await act(async () => {
      group
        .querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!
        .click();
    });
    expect(mocks.writeText).toHaveBeenCalledWith(html);
    act(() => {
      group
        .querySelector<HTMLButtonElement>('[aria-label="Download code"]')!
        .click();
    });
    expect(await readBlob(mocks.saveFile.mock.calls[0][0])).toBe(html);
  });
});
