'use client';

import React, { memo, useEffect, useMemo, useState, useId } from 'react';

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
  const preserveId = useId();

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
      caps.outputFormats
        .filter(
          (value) => params.background !== 'transparent' || value !== 'jpeg',
        )
        .map((value) => ({
          value,
          label: value.toUpperCase(),
        })),
    [caps.outputFormats, params.background],
  );

  const backgroundOptions = useMemo(
    () =>
      caps.backgrounds.map((value) => ({
        value: value === 'auto' ? '' : value,
        label:
          value === 'transparent'
            ? 'Transparent (preview)'
            : labelForValue(value),
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
            <div className="text-sm font-medium text-primary">Settings</div>
          </div>
          <span className="rounded-full bg-fill/5 px-2 py-1 text-xs text-muted md:text-[0.75rem]">
            {mode}
          </span>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3">
          <Select
            label="Model"
            value={model}
            options={[{ value: caps.model, label: caps.label }]}
            onChange={(value) => {
              if (value === caps.model) setModel(caps.model);
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
          {params.background === 'transparent' && (
            <p className="col-span-full text-[0.75rem] leading-relaxed text-muted">
              Transparent output uses PNG or WebP. For best results, describe an
              isolated subject and avoid asking for a backdrop or scene.
            </p>
          )}
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
          {mode === 'generate' && (
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
          )}
        </div>
      </div>

      {mode === 'edit' && (
        <div className="border-t border-separator/70 pt-4">
          <label
            htmlFor={preserveId}
            className="mb-2 block text-xs font-medium text-muted"
          >
            Preserve list
          </label>
          <Textarea
            id={preserveId}
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
  const sizeId = useId();
  const widthId = useId();
  const heightId = useId();
  const errorId = useId();
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
    <div className="col-span-full">
      <FieldLabel htmlFor={sizeId}>Size</FieldLabel>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <select
          id={sizeId}
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
          className="h-11 rounded-md border border-separator/70 bg-control px-2 text-sm text-secondary transition-colors hover:bg-fill/5 hover:text-primary md:min-h-9 md:text-xs"
        >
          Custom
        </button>
      </div>
      {(customActive || draftingCustom || width || height) && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-20">
            <FieldLabel htmlFor={widthId}>Width (px)</FieldLabel>
            <input
              id={widthId}
              type="number"
              min={16}
              max={3840}
              step={16}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              placeholder="Width"
              aria-label="Image width"
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              className={fieldClassName}
            />
          </div>
          <div className="min-w-0 flex-1 basis-20">
            <FieldLabel htmlFor={heightId}>Height (px)</FieldLabel>
            <input
              id={heightId}
              type="number"
              min={16}
              max={3840}
              step={16}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              placeholder="Height"
              aria-label="Image height"
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              className={fieldClassName}
            />
          </div>
          <button
            type="button"
            onClick={applyCustom}
            className="min-h-11 rounded-lg bg-action px-3 py-2 text-sm font-medium text-on-action transition-colors hover:opacity-90"
          >
            Apply
          </button>
        </div>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-nvidia-red">
          {error}
        </p>
      )}
    </div>
  );
}

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-medium text-muted"
    >
      {children}
    </label>
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
  const id = useId();
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
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
  const id = useId();
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
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
  'min-h-11 w-full min-w-0 rounded-lg border border-separator/70 bg-control px-2 text-sm text-primary focus:outline-none focus:ring-1 focus:ring-nvidia-green/60 md:min-h-9 md:text-xs';
