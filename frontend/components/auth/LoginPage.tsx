'use client';

import React, { useState, useEffect } from 'react';
import { IconUser, IconLock, IconAlertCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import toast from 'react-hot-toast';
import { GalaxyBackground } from './GalaxyBackground';
import { GlassCard } from '@/components/surfaces';
import { Button } from '@/components/primitives';
import { Input } from '@/components/primitives';
import { Logger } from '@/utils/logger';

const logger = new Logger('LoginPage');

export const LoginPage: React.FC = () => {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // SECURITY: Detect and clear credential query parameters
  useEffect(() => {
    const { query } = router;
    if (query.username || query.password) {
      logger.warn('[SECURITY] Credentials detected in URL query parameters. Clearing.');
      toast.error('Security: Credentials should not be in the URL. Please use the login form.');
      const cleanQuery = { ...query };
      delete cleanQuery.username;
      delete cleanQuery.password;
      router.replace({ pathname: router.pathname, query: cleanQuery }, undefined, { shallow: true });
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Login failed');

      router.push('/');
    } catch (err: any) {
      setError(err.message || 'An error occurred during login');
      toast.error(err.message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-bg-primary">
      <GalaxyBackground />

      <div className="relative z-10 w-full max-w-md px-4 animate-morph-in">
        <GlassCard variant="elevated" padding="lg" className="space-y-8">
          {/* Logo */}
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <img
                src="/main-logo.png"
                alt="Daedalus"
                className="h-16 w-auto"
              />
            </div>
            <h1 className="text-2xl font-bold text-dark-text-primary tracking-tight">
              Sign In
            </h1>
            <p className="mt-2 text-sm text-dark-text-muted">
              Enter your credentials to continue
            </p>
          </div>

          {/* Form */}
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-3">
              <label htmlFor="username" className="sr-only">Username</label>
              <Input
                id="username"
                type="text"
                placeholder="Username"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isLoading}
                leftIcon={<IconUser size={18} />}
                error={!!error}
              />

              <label htmlFor="password" className="sr-only">Password</label>
              <Input
                id="password"
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                leftIcon={<IconLock size={18} />}
                error={!!error}
              />
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-nvidia-red/10 border border-nvidia-red/20 animate-shake">
                <IconAlertCircle size={18} className="text-nvidia-red flex-shrink-0 mt-0.5" />
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
      </div>
    </div>
  );
};
