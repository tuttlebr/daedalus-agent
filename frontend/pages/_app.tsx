import { Toaster } from 'react-hot-toast';
import { QueryClient, QueryClientProvider } from 'react-query';

import { appWithTranslation } from 'next-i18next';
import type { AppProps } from 'next/app';
import { Inter } from 'next/font/google';
import { useEffect } from 'react';

import '@/styles/globals.css';
import { AuthProvider } from '@/components/Auth/AuthProvider';
import { OfflineIndicator } from '@/components/PWA/OfflineIndicator';
import { getSettings } from '@/utils/app/settings';
import { registerServiceWorker, setupOfflineDetection, setupInstallPrompt } from '@/utils/app/pwa';
import { startMemoryMonitoring } from '@/utils/app/memoryMonitor';
import toast from 'react-hot-toast';

const inter = Inter({ subsets: ['latin'] });

function App({ Component, pageProps }: AppProps<{}>) {

  const queryClient = new QueryClient();

  useEffect(() => {
    // Apply theme on mount
    const settings = getSettings();
    const theme = settings.theme || 'dark';

    // Apply theme class to html element
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    // Register PWA
    registerServiceWorker();
    setupInstallPrompt();
    setupOfflineDetection(
      () => {
        toast.error('You are offline. Some features may be limited.');
      },
      () => {
        toast.success('Back online!');
      }
    );

    // Start memory monitoring
    startMemoryMonitoring({
      warningThreshold: 80,
      criticalThreshold: 90,
      checkInterval: 10000, // Check every 10 seconds
    });
  }, []);

  return (
    <div className={inter.className}>
      {/* Skip to main content link for accessibility */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Toaster
        toastOptions={{
          style: {
            maxWidth: 500,
            wordBreak: 'break-all',
          },
        }}
      />
      <OfflineIndicator />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Component {...pageProps} />
        </AuthProvider>
      </QueryClientProvider>
    </div>
  );
}

export default appWithTranslation(App);
