'use client';

import React from 'react';
import { Textarea } from '@/components/primitives';

interface PreserveListInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function PreserveListInput({ value, onChange, disabled }: PreserveListInputProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        Preserve list
      </label>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
        What should NOT change. Appended to the prompt as "Keep everything else
        the same, specifically: …" to fight drift across iterations.
      </p>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="face, facial features, pose, clothing, camera angle, lighting, shadows"
        disabled={disabled}
        rows={3}
        className="min-h-[72px] resize-y"
      />
    </div>
  );
}
