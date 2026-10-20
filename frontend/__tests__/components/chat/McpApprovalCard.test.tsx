import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { McpApprovalCard } from '@/components/chat/McpApprovalCard';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const approval = {
  version: 1 as const,
  requestId: 'approval-request-1',
  serverName: 'docs_mcp_server',
  toolName: 'update_document',
  target: 'Quarterly plan',
  summary: 'Update the quarterly plan',
  argumentsSha256: 'a'.repeat(64),
};

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

describe('McpApprovalCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('recovers when the first status read fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(json({ status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<McpApprovalCard approval={approval} jobId="job-1" />);
    });
    expect(container.textContent).toContain('Loading approval');

    // A transient failure must not leave the decision unreachable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Loading approval');
    expect(
      Array.from(container.querySelectorAll('button')).map(
        (button) => button.textContent,
      ),
    ).toEqual(['Approve', 'Deny']);
    act(() => root.unmount());
  });

  it('accepts slow status responses while the next poll is still pending', async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(json({ status: 'pending' })), 2000);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<McpApprovalCard approval={approval} jobId="job-1" />);
      });
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain('Loading approval');
      expect(
        Array.from(container.querySelectorAll('button')).map(
          (button) => button.textContent,
        ),
      ).toEqual(['Approve', 'Deny']);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['pending', 'error'])(
    'keeps a completed decision when an older status read returns %s',
    async (outcome) => {
      let finish!: () => void;
      const initial = new Promise<any>((resolve, reject) => {
        finish = () =>
          outcome === 'pending'
            ? resolve(json({ status: 'pending' }))
            : reject(new Error('Old status failed'));
      });
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(initial)
        .mockResolvedValueOnce(json({ status: 'pending' }))
        .mockResolvedValueOnce(json({ status: 'completed' }));
      vi.stubGlobal('fetch', fetchMock);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<McpApprovalCard approval={approval} jobId="job-1" />);
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => vi.advanceTimersByTimeAsync(1500));
        const approve = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Approve',
        )!;
        await act(async () => approve.click());
        expect(container.textContent).toContain('Update completed');
        await act(async () => {
          finish();
          await initial.catch(() => {});
        });
        expect(container.textContent).toContain('Update completed');
        expect(container.querySelectorAll('button')).toHaveLength(0);
        expect(container.textContent).not.toContain('Old status failed');
      } finally {
        act(() => root.unmount());
      }
    },
  );
});
