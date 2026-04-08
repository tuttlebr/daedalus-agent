import React, { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from './AuthProvider';
import { Spinner } from '@/components/primitives';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg-primary">
        <div className="text-center">
          <Spinner size="lg" />
          <p className="mt-3 text-sm text-dark-text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return <>{children}</>;
};
