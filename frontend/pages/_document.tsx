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
        {/* Viewport for mobile optimization */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />

        {/* Web App Icons */}
        <link rel="icon" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/favicon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/favicon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon.png" />

        {/* Web App Manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* PWA Meta Tags */}
        <meta name="application-name" content="Daedalus" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Daedalus" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#76b900" />
        <meta name="description" content="Daedalus - AI Agent Interface" />
        
        {/* iOS Splash Screens */}
        <link rel="apple-touch-startup-image" href="/favicon.png" />
        
        {/* Edge/Windows */}
        <meta name="msapplication-TileColor" content="#76b900" />
        <meta name="msapplication-TileImage" content="/favicon.png" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
