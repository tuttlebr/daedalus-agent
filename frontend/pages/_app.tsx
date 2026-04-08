import { Toaster } from 'react-hot-toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { appWithTranslation } from 'next-i18next';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect, useState } from 'react';

import '@/styles/globals.css';
import { AuthProvider } from '@/components/auth';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { OfflineIndicator } from '@/components/pwa/OfflineIndicator';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';
import { UpdateToast } from '@/components/pwa/UpdateToast';
import { registerServiceWorker, setupOfflineDetection, setupInstallPrompt, setOnUpdateAvailable } from '@/utils/app/pwa';
import { startMemoryMonitoring } from '@/utils/app/memoryMonitor';
import toast from 'react-hot-toast';

function App({ Component, pageProps }: AppProps<{}>) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  }));
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  useEffect(() => {
    // Apply dark mode immediately to prevent flash
    document.documentElement.classList.add('dark');

    registerServiceWorker();
    setupInstallPrompt();
    setOnUpdateAvailable(() => setShowUpdateToast(true));
    setupOfflineDetection(
      () => toast.error('You are offline. Some features may be limited.'),
      () => toast.success('Back online!')
    );

    startMemoryMonitoring({
      warningThreshold: 80,
      criticalThreshold: 90,
      checkInterval: 60000,
    });
  }, []);

  return (
    <div>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:left-0 focus:z-50 focus:bg-nvidia-green focus:text-white focus:px-4 focus:py-2 focus:rounded-br-lg"
      >
        Skip to main content
      </a>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />
      </Head>
      <Toaster
        toastOptions={{
          style: {
            maxWidth: 500,
            background: '#1a1a1a',
            color: '#f5f5f5',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '12px',
            fontSize: '14px',
          },
        }}
        containerStyle={{
          top: 'max(1rem, calc(env(safe-area-inset-top) + 20px))',
        }}
      />
      <OfflineIndicator />
      <InstallPrompt />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ErrorBoundary>
            <Component {...pageProps} />
          </ErrorBoundary>
        </AuthProvider>
      </QueryClientProvider>
      {showUpdateToast && <UpdateToast onDismiss={() => setShowUpdateToast(false)} />}
    </div>
  );
}

export default appWithTranslation(App);
