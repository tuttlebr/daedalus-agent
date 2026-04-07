import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/router';
import { setStorageUser, clearUserSessionData, migrateLegacyStorage } from '@/utils/app/storage';
import { Logger } from '@/utils/logger';

const logger = new Logger('AuthProvider');

interface User {
  id: string;
  username: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
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
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const checkAuth = async () => {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include'  // Ensure cookies are sent
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        // SECURITY: Set the storage user to ensure user-specific storage keys
        setStorageUser(data.user.username);
        // Migrate any legacy non-user-specific data
        migrateLegacyStorage(data.user.username);
      } else {
        setUser(null);
        // SECURITY: Clear storage user when not authenticated
        setStorageUser(null);
      }
    } catch (error) {
      logger.error('Auth check failed:', error);
      setUser(null);
      // SECURITY: Clear storage user on error
      setStorageUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
      credentials: 'include'  // Ensure cookies are sent
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Login failed');
    }

    // SECURITY: Clear any existing session data before setting new user
    // This prevents data leakage from previous user sessions
    clearUserSessionData();

    setUser(data.user);

    // SECURITY: Set the storage user to ensure user-specific storage keys
    setStorageUser(data.user.username);

    // Migrate any legacy non-user-specific data for this user
    migrateLegacyStorage(data.user.username);

    router.push('/');
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'  // Ensure cookies are sent
      });
    } catch (error) {
      logger.error('Logout error:', error);
    } finally {
      // SECURITY: Clear all user-specific session data on logout
      clearUserSessionData();

      setUser(null);

      // SECURITY: Clear storage user reference
      setStorageUser(null);

      router.push('/login');
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    logout,
    checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
