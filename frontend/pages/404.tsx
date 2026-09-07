import Link from 'next/link';

import { branding } from '@/generated/branding';

export default function Custom404() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="safe-y flex min-h-screen flex-col items-center justify-center bg-dark-bg-primary px-4"
    >
      <div className="max-w-md text-center">
        <div className="mb-8">
          <img
            src={branding.assets['/favicon.png']}
            alt="Daedalus"
            className="h-16 w-auto mx-auto"
          />
        </div>
        <h1 className="mb-2 text-6xl font-bold text-dark-text-primary">404</h1>
        <p className="mb-8 text-lg text-dark-text-muted">Page Not Found</p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-on-action bg-action rounded-xl hover:brightness-95 transition-colors duration-200"
        >
          Go Home
        </Link>
      </div>
    </main>
  );
}
