'use client';

import { IconUser, IconLock, IconAlertCircle } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

import { useRouter } from 'next/router';

import { Logger } from '@/utils/logger';

import { AppearanceSettings } from '@/components/layout/AppearanceSettings';
import { Button } from '@/components/primitives';
import { Input } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

import { useAuth } from './AuthProvider';

import { branding } from '@/generated/branding';

const logger = new Logger('LoginPage');

export const LoginPage: React.FC = () => {
  const router = useRouter();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // SECURITY: Detect and clear credential query parameters
  useEffect(() => {
    const { query } = router;
    if (query.username || query.password) {
      logger.warn(
        '[SECURITY] Credentials detected in URL query parameters. Clearing.',
      );
      toast.error(
        'Security: Credentials should not be in the URL. Please use the login form.',
      );
      const cleanQuery = { ...query };
      delete cleanQuery.username;
      delete cleanQuery.password;
      router.replace(
        { pathname: router.pathname, query: cleanQuery },
        undefined,
        { shallow: true },
      );
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || 'An error occurred during login');
      toast.error(err.message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="min-h-[100dvh] flex items-center justify-center bg-app safe-y py-8"
    >
      <div className="w-full max-w-md px-4">
        <GlassCard variant="elevated" padding="lg" className="space-y-8">
          {/* Logo */}
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <img
                src={branding.assets['/favicon.png']}
                alt="Daedalus"
                className="h-16 w-auto"
              />
            </div>
            <h1 className="text-2xl font-bold text-dark-text-primary tracking-tight">
              Welcome to Daedalus
            </h1>
            <p className="mt-2 text-sm text-dark-text-muted">
              Sign in to your personal AI workspace.
            </p>
          </div>

          {/* Form */}
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-3">
              <label
                htmlFor="username"
                className="block text-sm font-medium text-primary"
              >
                Username
              </label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isLoading}
                leftIcon={<IconUser size={18} />}
                error={!!error}
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
              />

              <label
                htmlFor="password"
                className="block text-sm font-medium text-primary"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                leftIcon={<IconLock size={18} />}
                error={!!error}
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>

            {/* Error */}
            {error && (
              <div
                role="alert"
                id="login-error"
                className="flex items-start gap-3 p-3 rounded-lg bg-nvidia-red/10 border border-nvidia-red/20 animate-shake"
              >
                <IconAlertCircle
                  size={18}
                  className="text-nvidia-red flex-shrink-0 mt-0.5"
                />
                <p className="text-sm text-nvidia-red-light">{error}</p>
              </div>
            )}

            {/* Submit */}
            <Button
              type="submit"
              variant="accent"
              size="lg"
              fullWidth
              isLoading={isLoading}
            >
              {isLoading ? 'Signing In...' : 'Sign In'}
            </Button>
          </form>
        </GlassCard>
        <div className="mt-6">
          <AppearanceSettings />
        </div>
      </div>
    </main>
  );
};
