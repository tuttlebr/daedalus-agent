'use client';

import React from 'react';
import type { ImageMode, ImageParams } from '@/state/imagePanelStore';

interface ParameterPanelProps {
  mode: ImageMode;
  params: ImageParams;
  onChange: <K extends keyof ImageParams>(key: K, value: ImageParams[K]) => void;
}

type Option<V extends string | number> = { value: V; label: string };

const QUALITY_OPTIONS: Option<string>[] = [
  { value: '', label: 'Auto (SDK default)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'standard', label: 'Standard (dall-e-3)' },
  { value: 'hd', label: 'HD (dall-e-3)' },
];

const SIZE_OPTIONS: Option<string>[] = [
  { value: '', label: 'Auto (SDK default)' },
  { value: 'auto', label: 'Auto (explicit)' },
  { value: '1024x1024', label: '1024×1024 (square)' },
  { value: '1024x1536', label: '1024×1536 (portrait)' },
  { value: '1536x1024', label: '1536×1024 (landscape)' },
  { value: '1024x1792', label: '1024×1792 (tall, dall-e-3)' },
  { value: '1792x1024', label: '1792×1024 (wide, dall-e-3)' },
];

const FORMAT_OPTIONS: Option<string>[] = [
  { value: '', label: 'PNG (default)' },
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];

const BACKGROUND_OPTIONS: Option<string>[] = [
  { value: '', label: 'Auto' },
  { value: 'opaque', label: 'Opaque' },
  { value: 'transparent', label: 'Transparent' },
];

const MODERATION_OPTIONS: Option<string>[] = [
  { value: '', label: 'Auto (default)' },
  { value: 'low', label: 'Low' },
];

const STYLE_OPTIONS: Option<string>[] = [
  { value: '', label: 'Default (gpt-image)' },
  { value: 'vivid', label: 'Vivid (dall-e-3)' },
  { value: 'natural', label: 'Natural (dall-e-3)' },
];

const FIDELITY_OPTIONS: Option<string>[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High (preserve identity)' },
];

export function ParameterPanel({ mode, params, onChange }: ParameterPanelProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-4">
      <label className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        Parameters
      </label>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="n (variations)"
          value={params.n ?? ''}
          min={1}
          max={10}
          onChange={(v) => onChange('n', v === '' ? undefined : Number(v))}
          help="1–10"
        />

        <SelectField
          label="Quality"
          value={params.quality ?? ''}
          options={QUALITY_OPTIONS}
          onChange={(v) => onChange('quality', (v || undefined) as ImageParams['quality'])}
        />

        <SelectField
          label="Size"
          value={params.size ?? ''}
          options={SIZE_OPTIONS}
          onChange={(v) => onChange('size', (v || undefined) as ImageParams['size'])}
        />

        <SelectField
          label="Output format"
          value={params.output_format ?? ''}
          options={FORMAT_OPTIONS}
          onChange={(v) =>
            onChange('output_format', (v || undefined) as ImageParams['output_format'])
          }
        />

        <SelectField
          label="Background"
          value={params.background ?? ''}
          options={BACKGROUND_OPTIONS}
          onChange={(v) =>
            onChange('background', (v || undefined) as ImageParams['background'])
          }
        />

        {(params.output_format === 'jpeg' || params.output_format === 'webp') && (
          <NumberField
            label="Output compression"
            value={params.output_compression ?? ''}
            min={0}
            max={100}
            onChange={(v) =>
              onChange('output_compression', v === '' ? undefined : Number(v))
            }
            help="0–100 (jpeg/webp)"
          />
        )}

        {mode === 'generate' && (
          <>
            <SelectField
              label="Moderation"
              value={params.moderation ?? ''}
              options={MODERATION_OPTIONS}
              onChange={(v) =>
                onChange('moderation', (v || undefined) as ImageParams['moderation'])
              }
            />
            <SelectField
              label="Style"
              value={params.style ?? ''}
              options={STYLE_OPTIONS}
              onChange={(v) => onChange('style', (v || undefined) as ImageParams['style'])}
            />
          </>
        )}

        {mode === 'edit' && (
          <SelectField
            label="Input fidelity"
            value={params.input_fidelity ?? ''}
            options={FIDELITY_OPTIONS}
            onChange={(v) =>
              onChange(
                'input_fidelity',
                (v || undefined) as ImageParams['input_fidelity'],
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function Label({ children, help }: { children: React.ReactNode; help?: string }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
        {children}
      </span>
      {help && (
        <span className="text-[10px] text-neutral-500 dark:text-neutral-500">{help}</span>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label: string;
  value: string;
  options: Option<string>[];
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <div>
      <Label help={help}>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 px-2 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-nvidia-green/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  help,
}: {
  label: string;
  value: number | '';
  min: number;
  max: number;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <div>
      <Label help={help}>{label}</Label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 px-2 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-nvidia-green/40"
      />
    </div>
  );
}
