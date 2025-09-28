import { Toaster } from 'react-hot-toast';
import { QueryClient, QueryClientProvider } from 'react-query';

import { appWithTranslation } from 'next-i18next';
import type { AppProps } from 'next/app';
import { Inter } from 'next/font/google';
import { useEffect } from 'react';

import '@/styles/globals.css';
import { AuthProvider } from '@/components/Auth/AuthProvider';
import { getSettings } from '@/utils/app/settings';

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
  }, []);

  return (
    <div className={inter.className}>
      <Toaster
        toastOptions={{
          style: {
            maxWidth: 500,
            wordBreak: 'break-all',
          },
        }}
      />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Component {...pageProps} />
        </AuthProvider>
      </QueryClientProvider>
    </div>
  );
}

export default appWithTranslation(App);
