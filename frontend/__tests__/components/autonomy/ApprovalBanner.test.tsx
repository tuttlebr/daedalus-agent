import { renderToStaticMarkup } from 'react-dom/server';

import { ApprovalBanner } from '@/components/autonomy/ApprovalBanner';

import { describe, expect, it, vi } from 'vitest';

describe('ApprovalBanner', () => {
  it('shows the exact MCP scope and redacted arguments before approval', () => {
    const html = renderToStaticMarkup(
      <ApprovalBanner
        approvals={[
          {
            id: 'approval-1',
            runId: 'run-1',
            status: 'pending',
            action: 'Scale the production API',
            reason: 'Requested by the operator',
            actionType: 'mcp_mutation',
            target: 'production/api',
            serverName: 'k8s_mcp_server',
            toolName: 'scale_deployment',
            argumentsPreview:
              '{"api_token":"[REDACTED]","name":"api","replicas":3}',
            argumentsSha256: 'a'.repeat(64),
            risk: 'medium',
            createdAt: 1,
          },
        ]}
        busyId={null}
        onResolve={vi.fn()}
      />,
    );

    expect(html).toContain('k8s_mcp_server');
    expect(html).toContain('scale_deployment');
    expect(html).toContain('production/api');
    expect(html).toContain('[REDACTED]');
    expect(html).not.toContain('actual-secret');
  });

  it('shows the exact target for non-MCP destructive actions', () => {
    const html = renderToStaticMarkup(
      <ApprovalBanner
        approvals={[
          {
            id: 'approval-memory',
            runId: 'run-memory',
            status: 'pending',
            action: 'Delete stored memories',
            reason: 'Requested by the user',
            actionType: 'delete_memory',
            target: 'alice',
            risk: 'high',
            createdAt: 1,
          },
        ]}
        busyId={null}
        onResolve={vi.fn()}
      />,
    );

    expect(html).toContain('target');
    expect(html).toContain('alice');
  });
});
