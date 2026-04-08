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
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setStorageUser(data.user.username);
        migrateLegacyStorage(data.user.username);
      } else {
        setUser(null);
        setStorageUser(null);
      }
    } catch (error) {
      logger.error('Auth check failed:', error);
      setUser(null);
      setStorageUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Login failed');

    clearUserSessionData();
    setUser(data.user);
    setStorageUser(data.user.username);
    migrateLegacyStorage(data.user.username);
    router.push('/');
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (error) {
      logger.error('Logout error:', error);
    } finally {
      clearUserSessionData();
      setUser(null);
      setStorageUser(null);
      router.push('/login');
    }
  };

  useEffect(() => { checkAuth(); }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
};
