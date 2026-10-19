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
});
