'use client';

import type { ReactNode } from 'react';

interface DayGroupProps {
  label: string;
  children: ReactNode;
}

export function DayGroup({ label, children }: DayGroupProps) {
  return (
    <section className="mb-10 last:mb-2">
      <header className="-mx-1 mb-4 bg-app px-1 py-2">
        <div className="flex items-baseline gap-3">
          <h2 className="font-mono text-[0.75rem] uppercase tracking-[0.24em] text-dark-text-muted">
            {label}
          </h2>
          <span className="h-px flex-1 bg-separator" />
        </div>
      </header>
      <div
        role="feed"
        aria-label={`${label} updates`}
        aria-busy={false}
        className="relative space-y-7 border-l border-separator/70 pl-4"
      >
        {children}
      </div>
    </section>
  );
}
