import { GalaxyAnimation } from '@/components/GalaxyAnimation';

export default function Custom500() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0a0a0a] px-4">
      <div className="animate-morph-in text-center">
        <GalaxyAnimation className="mx-auto mb-6 animate-float" />
        <h1 className="mb-2 text-4xl font-bold text-white">500</h1>
        <p className="mb-8 text-lg text-white/60">Something Went Wrong</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-xl bg-nvidia-green px-6 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(118,185,0,0.3)] transition-all hover:bg-nvidia-green-dark hover:shadow-[0_0_30px_rgba(118,185,0,0.5)]"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
