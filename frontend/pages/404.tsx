import Link from 'next/link';
import { GalaxyBackground } from '@/components/auth/GalaxyBackground';

export default function Custom404() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-dark-bg-primary px-4">
      <GalaxyBackground />
      <div className="relative z-10 animate-morph-in text-center">
        <div className="mb-8">
          <img src="/main-logo.png" alt="Daedalus" className="h-16 w-auto mx-auto animate-galaxy-float" />
        </div>
        <h1 className="mb-2 text-6xl font-bold text-dark-text-primary">404</h1>
        <p className="mb-8 text-lg text-dark-text-muted">Page Not Found</p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-white bg-nvidia-green rounded-xl hover:bg-nvidia-green-dark hover:shadow-glow-green transition-all duration-200"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
