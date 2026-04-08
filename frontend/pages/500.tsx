import { GalaxyBackground } from '@/components/auth/GalaxyBackground';

export default function Custom500() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-dark-bg-primary px-4">
      <GalaxyBackground />
      <div className="relative z-10 animate-morph-in text-center">
        <div className="mb-8">
          <img src="/main-logo.png" alt="Daedalus" className="h-16 w-auto mx-auto" />
        </div>
        <h1 className="mb-2 text-6xl font-bold text-dark-text-primary">500</h1>
        <p className="mb-8 text-lg text-dark-text-muted">Something Went Wrong</p>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-white bg-nvidia-green rounded-xl hover:bg-nvidia-green-dark hover:shadow-glow-green transition-all duration-200"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
