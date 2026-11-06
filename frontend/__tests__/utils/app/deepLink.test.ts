import { clearAppDeepLink, readAppDeepLink } from '@/utils/app/deepLink';

import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => window.history.replaceState(null, '', '/'));

describe('app deep links', () => {
  it('accepts valid conversation IDs and known views only', () => {
    expect(readAppDeepLink('?conversation=api-123&view=connections')).toEqual({
      conversationId: 'api-123',
      view: 'connections',
    });
    expect(readAppDeepLink('?conversation=../etc&view=admin')).toEqual({});
    expect(readAppDeepLink('')).toEqual({});
  });

  it('removes only deep-link parameters from the address', () => {
    window.history.replaceState(null, '', '/?conversation=c1&view=chat&x=1#h');
    clearAppDeepLink();
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe('/?x=1#h');
  });
});
