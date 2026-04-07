import { DocumentProps, Head, Html, Main, NextScript } from 'next/document';
import i18nextConfig from '../next-i18next.config';

type Props = DocumentProps & {
  // add custom document props
};

export default function Document(props: Props) {
  const currentLocale =
    props.__NEXT_DATA__.locale ?? i18nextConfig.i18n.defaultLocale;
  return (
    <Html lang={currentLocale}>
      <Head>
        {/* Preload critical fonts to reduce LCP on mobile */}
        <link rel="preload" href="/fonts/NVIDIASans_Rg.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/NVIDIASans_Md.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />

        {/* Web App Icons - properly sized assets in /icons/ */}
        <link rel="icon" href="/icons/icon-32x32.png" />
        <link rel="apple-touch-icon" href="/icons/icon-180x180.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180x180.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/icon-16x16.png" />

        {/* Web App Manifest - version query string forces cache refresh */}
        <link rel="manifest" href="/manifest.json?v=2" />

        {/* PWA Meta Tags */}
        <meta name="application-name" content="Daedalus" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Daedalus" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#76b900" />
        <meta name="description" content="AI Agent Interface" />

        {/* iOS Splash Screens - use 512x512 icon as splash (centered by iOS on theme background) */}
        {/* iPhone 15 Pro Max, 14 Pro Max (430x932 @3x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" />
        {/* iPhone 15 Pro, 14 Pro (393x852 @3x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" />
        {/* iPhone 14, 13, 12 (390x844 @3x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" />
        {/* iPhone SE 3rd gen, 8, 7, 6s (375x667 @2x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" />
        {/* iPad Pro 12.9" (1024x1366 @2x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)" />
        {/* iPad Pro 11" (834x1194 @2x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)" />
        {/* iPad Air, iPad 10th gen (820x1180 @2x) */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2)" />
        {/* Fallback for unmatched devices */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" />

        {/* Edge/Windows */}
        <meta name="msapplication-TileColor" content="#76b900" />
        <meta name="msapplication-TileImage" content="/icons/icon-144x144.png" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
