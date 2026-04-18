'use client';

import React from 'react';
import { Textarea } from '@/components/primitives';

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function PromptInput({
  value,
  onChange,
  placeholder,
  disabled,
}: PromptInputProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        Prompt
      </label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          placeholder ??
          'Describe what you want. Order: scene → subject → key visual details → constraints. Put literal text in quotes.'
        }
        disabled={disabled}
        rows={6}
        className="min-h-[140px] resize-y"
      />
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
        {value.trim().length === 0
          ? 'Empty prompt — presets below can seed one.'
          : `${value.trim().length} chars`}
      </p>
    </div>
  );
}
