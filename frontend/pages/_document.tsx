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

        {/* iOS Splash Screens */}
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
          media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2)"
        />
        <link
          rel="apple-touch-startup-image"
          href={branding.assets['/icons/icon-512x512.png']}
        />

        {/* Windows */}
        <meta name="msapplication-TileColor" content="#76b900" />
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
          try {
            var s = JSON.parse(localStorage.getItem('ui-settings') || '{}');
            var mode = s && s.state && s.state.lightMode;
            var dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
            document.documentElement.classList.toggle('dark', dark);
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
