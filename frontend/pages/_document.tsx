import { DocumentProps, Head, Html, Main, NextScript } from 'next/document';
import i18nextConfig from '../next-i18next.config';

type Props = DocumentProps;

export default function Document(props: Props) {
  const currentLocale = props.__NEXT_DATA__.locale ?? i18nextConfig.i18n.defaultLocale;

  return (
    <Html lang={currentLocale} className="dark">
      <Head>
        {/* Preload critical fonts */}
        <link rel="preload" href="/fonts/NVIDIASans_Rg.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/NVIDIASans_Md.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/NVIDIASans_Bd.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />

        {/* Icons */}
        <link rel="icon" href="/icons/icon-32x32.png" />
        <link rel="apple-touch-icon" href="/icons/icon-180x180.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180x180.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/icon-16x16.png" />

        {/* Web App Manifest */}
        <link rel="manifest" href="/manifest.json?v=2" />

        {/* PWA Meta */}
        <meta name="application-name" content="Daedalus" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Daedalus" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#76b900" />
        <meta name="description" content="AI Agent Interface" />

        {/* iOS Splash Screens */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2)" />
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" />

        {/* Windows */}
        <meta name="msapplication-TileColor" content="#76b900" />
        <meta name="msapplication-TileImage" content="/icons/icon-144x144.png" />
      </Head>
      <body className="bg-dark-bg-primary text-dark-text-primary antialiased">
        {/* Prevent flash of wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var s = JSON.parse(localStorage.getItem('ui-settings') || '{}');
            if (s && s.state && s.state.lightMode === 'light') {
              document.documentElement.classList.remove('dark');
            }
          } catch(e) {}
        `}} />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
