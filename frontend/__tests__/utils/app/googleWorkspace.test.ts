import {
  googleWorkspaceAuthRecoveryMessage,
  inferGoogleWorkspaceService,
} from '@/utils/app/googleWorkspace';

import { describe, expect, it } from 'vitest';

describe('Google Workspace UI auth helpers', () => {
  it('identifies the service from an OAuth URL', () => {
    expect(
      inferGoogleWorkspaceService(
        'https://accounts.google.com/o/oauth2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments',
      ),
    ).toBe('Google Docs');
  });

  it('turns a per-user MCP auth failure into an actionable UI error', () => {
    expect(
      googleWorkspaceAuthRecoveryMessage(
        JSON.stringify({
          error: 'mcp_user_authentication_required',
          server: 'docs_mcp_server',
          retryable: false,
        }),
      ),
    ).toBe(
      'Google Docs authorization needs attention. Open Connections, choose Reconnect for Google Docs, then retry your request.',
    );
  });

  it('ignores unrelated and malformed tool output', () => {
    expect(googleWorkspaceAuthRecoveryMessage('not json')).toBeNull();
    expect(
      googleWorkspaceAuthRecoveryMessage(
        JSON.stringify({ error: 'mcp_tool_failed', server: 'docs_mcp_server' }),
      ),
    ).toBeNull();
  });
});
