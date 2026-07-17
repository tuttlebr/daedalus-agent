import { useQueryClient } from '@tanstack/react-query';
import React, {
  createContext,
  useContext,
  useEffect,
  ReactNode,
  useCallback,
} from 'react';

import { useRouter } from 'next/router';

import { clearPrivateCaches } from '@/utils/app/pwa';
import { useAuthMe, type AuthMeUser } from '@/utils/app/queries';
import { queryKeys } from '@/utils/app/queries/keys';
import {
  setStorageUser,
  clearUserSessionData,
  migrateLegacyStorage,
} from '@/utils/app/storage';
import { Logger } from '@/utils/logger';

const logger = new Logger('AuthProvider');

interface AuthContextType {
  user: AuthMeUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: user = null, isLoading, refetch } = useAuthMe();

  useEffect(() => {
    if (user) {
      setStorageUser(user.username);
      migrateLegacyStorage(user.username);
    } else if (!isLoading) {
      setStorageUser(null);
    }
  }, [user, isLoading]);

  const checkAuth = useCallback(async () => {
    try {
      await refetch();
    } catch (error) {
      logger.error('Auth check failed:', error);
    }
  }, [refetch]);

  const login = useCallback(
    async (username: string, password: string) => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Login failed');

      clearUserSessionData();
      // Drop any prior user's offline-cached private data before loading this
      // user's data (shared-device protection).
      await clearPrivateCaches();
      queryClient.setQueryData(queryKeys.auth.me, data.user as AuthMeUser);
      setStorageUser(data.user.username);
      migrateLegacyStorage(data.user.username);
      router.push('/');
    },
    [queryClient, router],
  );

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      logger.error('Logout error:', error);
    } finally {
      clearUserSessionData();
      // Drop offline-cached private data so it cannot be served to the next
      // user on a shared device.
      await clearPrivateCaches();
      queryClient.setQueryData(queryKeys.auth.me, null);
      queryClient.clear();
      setStorageUser(null);
      router.push('/login');
    }
  }, [queryClient, router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
