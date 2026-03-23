import Link from 'next/link';

import { GalaxyAnimation } from '@/components/GalaxyAnimation';

export default function Custom404() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0a0a0a] px-4">
      <div className="animate-morph-in text-center">
        <GalaxyAnimation className="mx-auto mb-6 animate-float" />
        <h1 className="mb-2 text-4xl font-bold text-white">404</h1>
        <p className="mb-8 text-lg text-white/60">Page Not Found</p>
        <Link
          href="/"
          className="inline-block rounded-xl bg-nvidia-green px-6 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(118,185,0,0.3)] transition-all hover:bg-nvidia-green-dark hover:shadow-[0_0_30px_rgba(118,185,0,0.5)]"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
