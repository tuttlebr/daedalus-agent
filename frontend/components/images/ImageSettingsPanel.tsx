'use client';

import React, { memo, useEffect, useMemo, useState } from 'react';

import {
  getImageModelCapabilities,
  isPopularImageSize,
  parseImageSize,
  validateImageSize,
  type ImageSize,
} from '@/utils/app/imageModelCapabilities';

import { Textarea } from '@/components/primitives';

import {
  useImagePanelStore,
  selectMode,
  type ImageParams,
} from '@/state/imagePanelStore';
import classNames from 'classnames';

type Option<V extends string> = { value: V | ''; label: string };

interface ImageSettingsPanelProps {
  variant?: 'sidebar' | 'sheet';
}

export const ImageSettingsPanel = memo(function ImageSettingsPanel({
  variant = 'sidebar',
}: ImageSettingsPanelProps) {
  const model = useImagePanelStore((s) => s.model);
  const setModel = useImagePanelStore((s) => s.setModel);
  const params = useImagePanelStore((s) => s.params);
  const setParam = useImagePanelStore((s) => s.setParam);
  const preserveList = useImagePanelStore((s) => s.preserveList);
  const setPreserveList = useImagePanelStore((s) => s.setPreserveList);
  const mode = useImagePanelStore(selectMode);

  const caps = getImageModelCapabilities(model);

  const qualityOptions = useMemo(
    () =>
      caps.qualities.map((value) => ({
        value: value === 'auto' ? '' : value,
        label: labelForValue(value),
      })),
    [caps.qualities],
  );

  const sizeOptions = useMemo(
    () =>
      caps.sizes.map((value) => ({
        value: value === 'auto' ? '' : value,
        label: value === 'auto' ? 'Auto' : formatSizeLabel(value),
      })),
    [caps.sizes],
  );

  const formatOptions = useMemo(
    () =>
      caps.outputFormats.map((value) => ({
        value,
        label: value.toUpperCase(),
      })),
    [caps.outputFormats],
  );

  const backgroundOptions = useMemo(
    () =>
      caps.backgrounds.map((value) => ({
        value: value === 'auto' ? '' : value,
        label: labelForValue(value),
      })),
    [caps.backgrounds],
  );

  const moderationOptions = useMemo(
    () =>
      caps.moderation.map((value) => ({
        value: value === 'auto' ? '' : value,
        label: labelForValue(value),
      })),
    [caps.moderation],
  );

  const customSize = params.size && !isPopularImageSize(params.size, model);

  return (
    <div
      className={classNames(
        variant === 'sidebar'
          ? 'flex h-full flex-col gap-5 overflow-y-auto p-4'
          : 'p-4',
      )}
    >
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-neutral-100">Settings</div>
          </div>
          <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-neutral-400">
            {mode}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Model"
            value={model}
            options={[{ value: 'gpt-image-2', label: caps.label }]}
            onChange={(value) => {
              if (value === 'gpt-image-2') setModel(value);
            }}
          />
          <Select
            label="Outputs"
            value={String(params.n ?? 1)}
            options={caps.outputCounts.map((value) => ({
              value: String(value),
              label: `${value} image${value === 1 ? '' : 's'}`,
            }))}
            onChange={(value) => {
              const next = Number(value);
              setParam('n', next === 1 ? undefined : next);
            }}
          />
          <Select
            label="Quality"
            value={params.quality ?? ''}
            options={qualityOptions}
            onChange={(value) =>
              setParam(
                'quality',
                (value || undefined) as ImageParams['quality'],
              )
            }
          />
          <SizeControl
            value={params.size}
            options={sizeOptions}
            customActive={Boolean(customSize)}
            onChange={(value) =>
              setParam('size', (value || undefined) as ImageParams['size'])
            }
          />
          <Select
            label="Format"
            value={params.output_format ?? 'png'}
            options={formatOptions}
            onChange={(value) =>
              setParam(
                'output_format',
                (value || undefined) as ImageParams['output_format'],
              )
            }
          />
          <Select
            label="Background"
            value={params.background ?? ''}
            options={backgroundOptions}
            onChange={(value) =>
              setParam(
                'background',
                (value || undefined) as ImageParams['background'],
              )
            }
          />
          {(params.output_format === 'jpeg' ||
            params.output_format === 'webp') && (
            <NumberInput
              label="Compression"
              value={params.output_compression ?? ''}
              min={0}
              max={100}
              onChange={(value) =>
                setParam(
                  'output_compression',
                  value === '' ? undefined : Number(value),
                )
              }
            />
          )}
          <Select
            label="Moderation"
            value={params.moderation ?? ''}
            options={moderationOptions}
            onChange={(value) =>
              setParam(
                'moderation',
                (value || undefined) as ImageParams['moderation'],
              )
            }
          />
        </div>
      </div>

      {mode === 'edit' && (
        <div className="border-t border-white/5 pt-4">
          <label className="mb-2 block text-[10px] uppercase tracking-wider text-neutral-500">
            Preserve list
          </label>
          <Textarea
            value={preserveList}
            onChange={(e) => setPreserveList(e.target.value)}
            placeholder="face, pose, clothing, camera angle, lighting"
            rows={3}
            className="text-xs"
          />
        </div>
      )}
    </div>
  );
});

function SizeControl({
  value,
  options,
  customActive,
  onChange,
}: {
  value?: ImageSize;
  options: Option<string>[];
  customActive: boolean;
  onChange: (value: string) => void;
}) {
  const parsed = useMemo(() => parseImageSize(value), [value]);
  const [width, setWidth] = useState(parsed?.width ? String(parsed.width) : '');
  const [height, setHeight] = useState(
    parsed?.height ? String(parsed.height) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [draftingCustom, setDraftingCustom] = useState(false);

  useEffect(() => {
    if (!parsed) {
      if (!customActive && !draftingCustom) {
        setWidth('');
        setHeight('');
      }
      return;
    }
    setWidth(String(parsed.width));
    setHeight(String(parsed.height));
  }, [customActive, draftingCustom, parsed]);

  const startCustom = () => {
    setDraftingCustom(true);
    if (!width) setWidth(parsed?.width ? String(parsed.width) : '2048');
    if (!height) setHeight(parsed?.height ? String(parsed.height) : '2048');
  };

  const applyCustom = () => {
    const next = `${width}x${height}`;
    const result = validateImageSize(next);
    if (!result.valid) {
      setError(result.reason ?? 'Invalid size');
      return;
    }
    setError(null);
    setDraftingCustom(false);
    onChange(next);
  };

  return (
    <div className="col-span-2">
      <FieldLabel>Size</FieldLabel>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <select
          value={customActive || draftingCustom ? 'custom' : value ?? ''}
          onChange={(e) => {
            setError(null);
            if (e.target.value === 'custom') {
              startCustom();
              return;
            }
            setDraftingCustom(false);
            setWidth('');
            setHeight('');
            onChange(e.target.value);
          }}
          className={fieldClassName}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
        <button
          type="button"
          onClick={startCustom}
          className="h-11 rounded-md border border-white/10 bg-black/30 px-2 text-sm text-neutral-300 transition-colors hover:bg-white/5 hover:text-neutral-100 md:h-9 md:text-xs"
        >
          Custom
        </button>
      </div>
      {(customActive || draftingCustom || width || height) && (
        <div className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="number"
            min={16}
            max={3840}
            step={16}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            placeholder="Width"
            className={fieldClassName}
          />
          <input
            type="number"
            min={16}
            max={3840}
            step={16}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            placeholder="Height"
            className={fieldClassName}
          />
          <button
            type="button"
            onClick={applyCustom}
            className="h-11 rounded-md bg-white px-3 text-sm font-medium text-black transition-colors hover:bg-neutral-200 md:h-9 md:text-xs"
          >
            Apply
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
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
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClassName}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
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
  onChange: (value: string) => void;
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
        className={fieldClassName}
      />
    </div>
  );
}

function labelForValue(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatSizeLabel(size: ImageSize): string {
  return size === 'auto' ? 'Auto' : size;
}

const fieldClassName =
  'h-11 w-full rounded-md border border-white/10 bg-black/30 px-2 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-nvidia-green/60 md:h-9 md:text-xs';
