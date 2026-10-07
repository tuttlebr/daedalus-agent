import { Head, Html, Main, NextScript } from 'next/document';

import { branding } from '@/generated/branding';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Icons */}
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href={branding.assets['/icons/icon-180x180.png']}
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href={branding.assets['/icons/icon-32x32.png']}
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href={branding.assets['/icons/icon-16x16.png']}
        />

        {/* Web App Manifest */}
        <link rel="manifest" href={branding.manifest} />

        {/* PWA Meta */}
        <meta name="application-name" content="Daedalus" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content="Daedalus" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="description" content="AI Agent Interface" />

        {/* Windows */}
        <meta name="msapplication-TileColor" content="#161d27" />
        <meta
          name="msapplication-TileImage"
          content={branding.assets['/icons/icon-144x144.png']}
        />
      </Head>
      <body className="bg-dark-bg-primary text-dark-text-primary antialiased">
        {/* Prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
          var mode;
          try {
            var s = JSON.parse(localStorage.getItem('ui-settings') || '{}');
            mode = s && s.state && s.state.lightMode;
          } catch(e) {}
          try {
            var dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
            document.documentElement.classList.toggle('dark', dark);
            document.documentElement.dataset.theme = dark ? 'dark' : 'light';
          } catch(e) {}
          try {
            var standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
            if (standalone) document.documentElement.setAttribute('data-app-display-mode', 'standalone');
          } catch(e) {}
        `,
          }}
        />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
