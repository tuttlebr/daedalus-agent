'use client';

import type { ReactNode } from 'react';

interface DayGroupProps {
  label: string;
  children: ReactNode;
}

export function DayGroup({ label, children }: DayGroupProps) {
  return (
    <section className="mb-10 last:mb-2">
      <header className="sticky top-[64px] z-20 -mx-1 mb-4 bg-gradient-to-b from-[rgba(10,11,12,0.95)] via-[rgba(10,11,12,0.92)] to-transparent px-1 py-2 backdrop-blur-sm">
        <div className="flex items-baseline gap-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-dark-text-muted">
            {label}
          </h2>
          <span className="h-px flex-1 bg-gradient-to-r from-white/[0.08] to-transparent" />
        </div>
      </header>
      <div className="relative space-y-7 border-l border-white/[0.06] pl-4">
        {children}
      </div>
    </section>
  );
}
