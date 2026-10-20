import { inferGoogleWorkspaceService } from '@/utils/app/googleWorkspace';

import { describe, expect, it } from 'vitest';

describe('Google Workspace UI auth helpers', () => {
  it('identifies the service from an OAuth URL', () => {
    expect(
      inferGoogleWorkspaceService(
        'https://accounts.google.com/o/oauth2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments',
      ),
    ).toBe('Google Docs');
  });
});
