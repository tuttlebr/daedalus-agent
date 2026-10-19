import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  IntermediateStep,
  IntermediateStepType as Type,
} from '@/types/intermediateSteps';

import { IntermediateSteps } from '@/components/agent/IntermediateSteps';
import { MessageBubble } from '@/components/chat/MessageBubble';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = 1800000000000;
function event(
  type: Type,
  id: string,
  name = 'serpapi_search',
  data?: any,
): IntermediateStep {
  return {
    parent_id: 'root',
    function_ancestry: {
      node_id: name,
      parent_id: null,
      function_name: name,
      depth: 0,
    },
    payload: {
      event_type: type,
      UUID: id,
      name,
      event_timestamp: now / 1000 - (type.endsWith('START') ? 20 : 1),
      data,
    },
  };
}

let root: Root;
let container: HTMLDivElement;
function render(element: React.ReactNode) {
  act(() => root.render(element));
}
function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  act(() => button!.click());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('compact agent activity', () => {
  it.each([false, true])(
    'keeps live drilldown and selected details open as results arrive and the run finishes (shared UUID=%s)',
    (sharedUuid) => {
      const start = event(Type.TOOL_START, 'search-start', 'serpapi_search', {
        input: { query: 'release notes', internal_flag: 'technical-only' },
      });
      render(
        <IntermediateSteps
          steps={[start]}
          isStreaming
          progress={{ startedAt: now - 20000, updatedAt: now }}
        />,
      );
      expect(container.textContent).toContain('Searching the web');
      expect(container.textContent).toContain('1 tool running');
      expect(container.textContent).toContain('20s');
      click('button[aria-haspopup="dialog"]');
      expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
      click('button[aria-label="View Searching the web details"]');
      expect(document.querySelectorAll('dialog[open]')).toHaveLength(2);
      expect(document.body.textContent).not.toContain('technical-only');
      const result = event(
        Type.TOOL_END,
        sharedUuid ? 'search-start' : 'search-end',
        'serpapi_search',
        {
          output: {
            results: [
              { title: 'Release notes', url: 'https://example.com/releases' },
              { title: 'Changelog' },
            ],
          },
        },
      );
      render(<IntermediateSteps steps={[start, result]} durationMs={24000} />);
      expect(container.querySelector('button')?.textContent).toContain(
        'Completed in 24s',
      );
      expect(
        container.querySelector('button')?.getAttribute('aria-expanded'),
      ).toBe('true');
      expect(document.querySelectorAll('dialog[open]')).toHaveLength(2);
      const details = document.querySelector(
        'dialog[aria-label="Searching the web details"]',
      )!;
      expect(details.textContent).toContain('2 results');
      expect(details.querySelector('a')?.href).toBe(
        'https://example.com/releases',
      );
      click('button[aria-controls][aria-expanded="false"]');
      expect(details.textContent).toContain('technical-only');
      click('button[aria-label="Close activity details"]');
      const dialog = document.querySelector<HTMLDialogElement>(
        'dialog[aria-label="Agent activity"]',
      )!;
      act(() =>
        dialog.dispatchEvent(
          new Event('cancel', { bubbles: true, cancelable: true }),
        ),
      );
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('button'));
    },
  );

  it('counts operations in parallel and retains explicit failure and interruption outcomes', () => {
    const first = event(Type.TOOL_START, 'first');
    const second = event(Type.TOOL_START, 'second', 'smart_milvus');
    render(<IntermediateSteps steps={[first, second]} isStreaming />);
    expect(container.textContent).toContain('2 tools in progress');
    const end = event(Type.TOOL_END, 'first-end', 'serpapi_search', {
      output: '{"status":"error","content":"Search unavailable"}',
    });
    render(
      <IntermediateSteps steps={[first, second, end]} durationMs={24000} />,
    );
    expect(container.querySelector('button')?.textContent).toContain(
      'Finished with interrupted activity',
    );
    expect(container.querySelector('button')?.textContent).toContain(
      '2 tool calls · 1 failed',
    );
    click('button[aria-haspopup="dialog"]');
    const dialog = document.querySelector('dialog')!;
    expect(dialog.textContent).toContain('Failed');
    expect(dialog.textContent).toContain('Interrupted');
    expect(dialog.textContent).toContain('Search unavailable');
  });

  it('does not describe a finished tool as still running between agent steps', () => {
    const start = event(Type.TOOL_START, 'start');
    const end = event(Type.TOOL_END, 'end');
    render(
      <IntermediateSteps
        steps={[start, end]}
        isStreaming
        progress={{ text: 'Searching the web' }}
      />,
    );
    expect(container.querySelector('button')?.textContent).toContain(
      'Preparing next step',
    );
    expect(container.querySelector('button')?.textContent).not.toContain(
      'Searching the web',
    );
  });

  it('keeps elapsed time anchored across remounts without announcing timer ticks', () => {
    const props = {
      steps: [],
      isStreaming: true,
      progress: {
        startedAt: now - 20000,
        updatedAt: now,
        text: 'Generating response',
      },
    };
    render(<IntermediateSteps {...props} />);
    const initialAnnouncement =
      container.querySelector('[role="status"]')?.textContent;
    expect(initialAnnouncement).toBe('Preparing the answer');
    act(() => vi.advanceTimersByTime(12000));
    expect(container.textContent).toContain('32s');
    expect(container.textContent).toContain('last update 12s ago');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      initialAnnouncement,
    );
    render(null);
    render(<IntermediateSteps {...props} />);
    expect(container.textContent).toContain('32s');
  });

  it('uses real queue and authorization signals, and labels explicit retries', () => {
    render(
      <IntermediateSteps
        steps={[]}
        isStreaming
        progress={{ status: 'pending' }}
      />,
    );
    expect(container.querySelector('button')?.textContent).toContain('Queued');
    render(
      <IntermediateSteps
        steps={[]}
        isStreaming
        progress={{ status: 'oauth_required' }}
      />,
    );
    expect(container.querySelector('button')?.textContent).toContain(
      'Waiting for authorization',
    );
    const start = event(Type.TOOL_START, 'retry');
    start.payload.metadata = { status: 'retrying' };
    render(<IntermediateSteps steps={[start]} isStreaming />);
    expect(container.querySelector('button')?.textContent).toContain(
      'Retrying · Searching the web',
    );
  });

  it('keeps historical turns completed while another turn streams', () => {
    const start = event(Type.TOOL_START, 'past-start');
    const end = event(Type.TOOL_END, 'past-end');
    render(
      <>
        <IntermediateSteps steps={[start, end]} durationMs={3000} />
        <IntermediateSteps
          steps={[]}
          isStreaming
          progress={{ status: 'pending' }}
        />
      </>,
    );
    const rows = container.querySelectorAll('button');
    expect(rows[0].textContent).toContain('Completed in 3s');
    expect(rows[1].textContent).toContain('Queued');
  });

  it('retains an explicitly stopped receipt before any response token or tool call', async () => {
    await act(async () =>
      root.render(
        <MessageBubble
          messageIndex={1}
          message={{
            role: 'assistant',
            content: '',
            metadata: { stopped: true },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('Stopped');
  });

  it('uses one duration receipt for a stopped answer without tool history', async () => {
    await act(async () =>
      root.render(
        <MessageBubble
          messageIndex={1}
          message={{
            role: 'assistant',
            content: 'Partial answer',
            generationDurationMs: 5000,
            metadata: { stopped: true },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('Stopped in 5s');
    expect(container.textContent).not.toContain('Generated in');
  });

  it('makes a streaming message inspectable before the first answer token', async () => {
    await act(async () =>
      root.render(
        <MessageBubble
          messageIndex={1}
          message={{
            role: 'assistant',
            content: '',
            intermediateSteps: [event(Type.TOOL_START, 'live')],
          }}
          isStreaming
          activityProgress={{ startedAt: now - 20000 }}
        />,
      ),
    );
    expect(container.textContent).toContain('Searching the web');
    expect(container.querySelector('.chat-bubble-assistant')).toBeNull();
    click('button[aria-haspopup="dialog"]');
    expect(
      document.querySelector('dialog[aria-label="Agent activity"]'),
    ).not.toBeNull();
  });
});
