/**
 * User-aware storage utility
 * Ensures sessionStorage keys are scoped to the current user to prevent data leakage between users
 */

let currentUsername: string | null = null;

/**
 * Set the current username for storage scoping
 * This should be called after successful login and after auth check
 */
export function setStorageUser(username: string | null) {
  currentUsername = username;
}

/**
 * Get the current storage username
 */
export function getStorageUser(): string | null {
  return currentUsername;
}

/**
 * Generate a user-specific storage key
 * Format: user:<username>:<key>
 * If no user is logged in, uses 'anon:<key>' for backwards compatibility
 */
function getUserStorageKey(key: string): string {
  const username = currentUsername || 'anon';
  return `user:${username}:${key}`;
}

/**
 * Get item from sessionStorage with user-specific key
 */
export function getUserSessionItem(key: string): string | null {
  const userKey = getUserStorageKey(key);
  return sessionStorage.getItem(userKey);
}

/**
 * Set item in sessionStorage with user-specific key
 */
export function setUserSessionItem(key: string, value: string): void {
  const userKey = getUserStorageKey(key);
  sessionStorage.setItem(userKey, value);
}

/**
 * Remove item from sessionStorage with user-specific key
 */
export function removeUserSessionItem(key: string): void {
  const userKey = getUserStorageKey(key);
  sessionStorage.removeItem(userKey);
}

/**
 * Clear all user-specific data from sessionStorage
 * This should be called on logout
 */
export function clearUserSessionData(): void {
  if (!currentUsername) {
    // If no user, clear common anonymous keys as fallback
    const keysToRemove = [
      'conversationHistory',
      'selectedConversation',
      'folders',
      'prompts',
      'showChatbar',
      'chatCompletionURL',
      'enableIntermediateSteps',
      'expandIntermediateSteps',
      'intermediateStepOverride',
      'chatHistory',
      'sessionId'
    ];
    keysToRemove.forEach(key => sessionStorage.removeItem(key));
    return;
  }

  // Remove all keys for the current user
  const userPrefix = `user:${currentUsername}:`;
  const keysToRemove: string[] = [];

  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith(userPrefix)) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach(key => sessionStorage.removeItem(key));
}

/**
 * Clear ALL user data from sessionStorage (all users)
 * This is useful for complete cleanup or debugging
 */
export function clearAllUserData(): void {
  const keysToRemove: string[] = [];

  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith('user:')) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach(key => sessionStorage.removeItem(key));

  // Also clear legacy non-prefixed keys
  const legacyKeys = [
    'conversationHistory',
    'selectedConversation',
    'folders',
    'prompts',
    'showChatbar',
    'chatCompletionURL',
    'enableIntermediateSteps',
    'expandIntermediateSteps',
    'intermediateStepOverride',
    'chatHistory',
    'sessionId'
  ];
  legacyKeys.forEach(key => sessionStorage.removeItem(key));
}

/**
 * Migrate legacy non-user-specific data to user-specific keys
 * This helps with backwards compatibility
 */
export function migrateLegacyStorage(username: string): void {
  const legacyKeys = [
    'conversationHistory',
    'selectedConversation',
    'folders',
    'prompts',
    'showChatbar',
    'chatCompletionURL',
    'enableIntermediateSteps',
    'expandIntermediateSteps',
    'intermediateStepOverride',
    'chatHistory'
  ];

  legacyKeys.forEach(key => {
    const value = sessionStorage.getItem(key);
    if (value !== null) {
      // Copy to user-specific key
      const userKey = `user:${username}:${key}`;
      sessionStorage.setItem(userKey, value);
      // Remove legacy key
      sessionStorage.removeItem(key);
    }
  });
}
