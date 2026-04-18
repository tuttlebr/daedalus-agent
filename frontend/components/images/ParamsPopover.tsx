'use client';

import React from 'react';
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { Popover, Textarea } from '@/components/primitives';
import {
  useImagePanelStore,
  selectMode,
  type ImageParams,
} from '@/state/imagePanelStore';
import { DockIconTrigger } from './PresetsPopover';

type Option<V extends string> = { value: V | ''; label: string };

const QUALITY_OPTIONS: Option<string>[] = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'standard', label: 'Standard' },
  { value: 'hd', label: 'HD' },
];

const SIZE_OPTIONS: Option<string>[] = [
  { value: '', label: 'Auto' },
  { value: '1024x1024', label: '1024×1024' },
  { value: '1024x1536', label: '1024×1536' },
  { value: '1536x1024', label: '1536×1024' },
  { value: '1024x1792', label: '1024×1792' },
  { value: '1792x1024', label: '1792×1024' },
];

const FORMAT_OPTIONS: Option<string>[] = [
  { value: '', label: 'PNG' },
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
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
];

const STYLE_OPTIONS: Option<string>[] = [
  { value: '', label: 'Default' },
  { value: 'vivid', label: 'Vivid' },
  { value: 'natural', label: 'Natural' },
];

const FIDELITY_OPTIONS: Option<string>[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

interface ParamsPopoverProps {
  disabled?: boolean;
}

export function ParamsPopover({ disabled }: ParamsPopoverProps) {
  const params = useImagePanelStore((s) => s.params);
  const setParam = useImagePanelStore((s) => s.setParam);
  const preserveList = useImagePanelStore((s) => s.preserveList);
  const setPreserveList = useImagePanelStore((s) => s.setPreserveList);
  const mode = useImagePanelStore(selectMode);

  return (
    <Popover
      position="top"
      align="start"
      trigger={
        <DockIconTrigger disabled={disabled} aria-label="Parameters">
          <IconAdjustmentsHorizontal size={16} />
        </DockIconTrigger>
      }
    >
      <div className="p-4 w-80 max-h-[70vh] overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-3">
          Parameters
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Quality"
            value={params.quality ?? ''}
            options={QUALITY_OPTIONS}
            onChange={(v) => setParam('quality', (v || undefined) as ImageParams['quality'])}
          />
          <Select
            label="Size"
            value={params.size ?? ''}
            options={SIZE_OPTIONS}
            onChange={(v) => setParam('size', (v || undefined) as ImageParams['size'])}
          />
          <Select
            label="Format"
            value={params.output_format ?? ''}
            options={FORMAT_OPTIONS}
            onChange={(v) =>
              setParam('output_format', (v || undefined) as ImageParams['output_format'])
            }
          />
          <Select
            label="Background"
            value={params.background ?? ''}
            options={BACKGROUND_OPTIONS}
            onChange={(v) =>
              setParam('background', (v || undefined) as ImageParams['background'])
            }
          />

          {(params.output_format === 'jpeg' || params.output_format === 'webp') && (
            <NumberInput
              label="Compression"
              value={params.output_compression ?? ''}
              min={0}
              max={100}
              onChange={(v) =>
                setParam(
                  'output_compression',
                  v === '' ? undefined : Number(v),
                )
              }
            />
          )}

          {mode === 'generate' && (
            <>
              <Select
                label="Moderation"
                value={params.moderation ?? ''}
                options={MODERATION_OPTIONS}
                onChange={(v) =>
                  setParam('moderation', (v || undefined) as ImageParams['moderation'])
                }
              />
              <Select
                label="Style"
                value={params.style ?? ''}
                options={STYLE_OPTIONS}
                onChange={(v) => setParam('style', (v || undefined) as ImageParams['style'])}
              />
            </>
          )}

          {mode === 'edit' && (
            <Select
              label="Input fidelity"
              value={params.input_fidelity ?? ''}
              options={FIDELITY_OPTIONS}
              onChange={(v) =>
                setParam(
                  'input_fidelity',
                  (v || undefined) as ImageParams['input_fidelity'],
                )
              }
            />
          )}
        </div>

        {mode === 'edit' && (
          <div className="mt-4 pt-4 border-t border-white/5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2 block">
              Preserve list
            </label>
            <p className="text-[11px] text-neutral-500 mb-2">
              Appended to the prompt as "keep everything else the same,
              specifically…" to fight drift.
            </p>
            <Textarea
              value={preserveList}
              onChange={(e) => setPreserveList(e.target.value)}
              placeholder="face, pose, clothing, camera angle, lighting"
              rows={2}
              className="text-xs"
            />
          </div>
        )}
      </div>
    </Popover>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
      {children}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option<string>[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 px-2 text-xs rounded-md bg-black/30 border border-white/10 text-neutral-100 focus:outline-none focus:ring-1 focus:ring-nvidia-green/60"
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

function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number | '';
  min: number;
  max: number;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 px-2 text-xs rounded-md bg-black/30 border border-white/10 text-neutral-100 focus:outline-none focus:ring-1 focus:ring-nvidia-green/60"
      />
    </div>
  );
}
