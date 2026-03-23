import { Toaster } from 'react-hot-toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { appWithTranslation } from 'next-i18next';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect, useState } from 'react';

import '@/styles/globals.css';
import { AuthProvider } from '@/components/Auth/AuthProvider';
import ErrorBoundary from '@/components/ErrorBoundary/ErrorBoundary';
import { OfflineIndicator } from '@/components/PWA/OfflineIndicator';
import { InstallPrompt } from '@/components/PWA/InstallPrompt';
import { UpdateToast } from '@/components/PWA/UpdateToast';
import { getSettings } from '@/utils/app/settings';
import { registerServiceWorker, setupOfflineDetection, setupInstallPrompt, setOnUpdateAvailable } from '@/utils/app/pwa';
import { startMemoryMonitoring } from '@/utils/app/memoryMonitor';
import toast from 'react-hot-toast';

function App({ Component, pageProps }: AppProps<{}>) {

  const [queryClient] = useState(() => new QueryClient());
  const [showUpdateToast, setShowUpdateToast] = useState(false);

  useEffect(() => {
    const settings = getSettings();
    const theme = settings.theme || 'dark';

    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    registerServiceWorker();
    setupInstallPrompt();
    setOnUpdateAvailable(() => setShowUpdateToast(true));
    setupOfflineDetection(
      () => {
        toast.error('You are offline. Some features may be limited.');
      },
      () => {
        toast.success('Back online!');
      }
    );

    startMemoryMonitoring({
      warningThreshold: 80,
      criticalThreshold: 90,
      checkInterval: 60000,
    });
  }, []);

  return (
    <div>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />
      </Head>
      <Toaster
        toastOptions={{
          style: {
            maxWidth: 500,
            wordBreak: 'break-all',
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
