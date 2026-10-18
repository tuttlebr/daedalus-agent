import {
  clearUserSessionData,
  getUserSessionItem,
  setStorageUser,
  setUserSessionItem,
} from '@/utils/app/storage';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('user-scoped session storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setStorageUser(null);
  });

  afterEach(() => {
    sessionStorage.clear();
    setStorageUser(null);
  });

  it('scopes entries to the current user', () => {
    setStorageUser('alice');
    setUserSessionItem('selectedConversation', 'alice data');
    setStorageUser('bob');
    expect(getUserSessionItem('selectedConversation')).toBeNull();
    setStorageUser('alice');
    expect(getUserSessionItem('selectedConversation')).toBe('alice data');
  });

  it.each([
    ['logout', 'alice'],
    ['login', null],
  ])(
    'drops history cached before identity resolved on %s',
    (_boundary, currentUser) => {
      // The app shell can finish loading history before /api/auth/me
      // resolves, which caches it under the anonymous scope.
      setStorageUser(null);
      setUserSessionItem('conversationHistory', '[{"id":"alice-private"}]');
      setStorageUser('alice');
      setUserSessionItem('selectedConversation', 'alice selection');
      sessionStorage.setItem('unrelated', 'kept');

      setStorageUser(currentUser);
      clearUserSessionData();

      // The next account on this tab may read the cache while its own
      // identity is still loading.
      setStorageUser(null);
      expect(getUserSessionItem('conversationHistory')).toBeNull();
      setStorageUser('alice');
      if (currentUser) {
        expect(getUserSessionItem('selectedConversation')).toBeNull();
      }
      expect(sessionStorage.getItem('unrelated')).toBe('kept');
    },
  );
});
