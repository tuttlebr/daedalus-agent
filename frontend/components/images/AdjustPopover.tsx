'use client';

import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
} from '@tabler/icons-react';
import React, { memo } from 'react';

import {
  applyPreset,
  presetsForMode,
  type ImagePreset,
} from '@/utils/app/imagePresets';

import { Popover } from '@/components/primitives';

import { ImageSettingsPanel } from './ImageSettingsPanel';
import { DockIconTrigger, PresetsPanel } from './PresetsPopover';

import {
  selectMode,
  useImagePanelStore,
  type ImageParams,
} from '@/state/imagePanelStore';

export const AdjustPopover = memo(function AdjustPopover({
  disabled,
}: {
  disabled?: boolean;
}) {
  const mode = useImagePanelStore(selectMode);
  const model = useImagePanelStore((state) => state.model);

  const handleApply = (preset: ImagePreset) => {
    const { prompt, setPrompt, setPreserveList, setParam } =
      useImagePanelStore.getState();
    const {
      prompt: nextPrompt,
      preserveList: nextPreserve,
      params: nextParams,
    } = applyPreset(preset, prompt, model, mode);
    setPrompt(nextPrompt);
    if (nextPreserve !== undefined) setPreserveList(nextPreserve);
    (Object.keys(nextParams) as (keyof ImageParams)[]).forEach((key) => {
      setParam(key, nextParams[key] as never);
    });
  };

  return (
    <Popover
      position="top"
      align="start"
      sheetOnMobile
      title="Adjust image"
      trigger={
        <DockIconTrigger disabled={disabled} aria-label="Adjust image" labeled>
          <IconAdjustmentsHorizontal size={17} />
          <span className="adjust-label">Adjust</span>
        </DockIconTrigger>
      }
    >
      <div className="divide-y divide-separator">
        <section aria-label="Image settings">
          <ImageSettingsPanel variant="sheet" />
        </section>
        <details className="group/presets p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <span>Presets</span>
            <IconChevronDown
              size={18}
              aria-hidden="true"
              className="shrink-0 transition-transform group-open/presets:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <PresetsPanel
            mode={mode}
            presets={presetsForMode(mode)}
            onApply={handleApply}
            showHeading={false}
          />
        </details>
      </div>
    </Popover>
  );
});
