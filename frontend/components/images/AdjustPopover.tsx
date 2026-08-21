'use client';

import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
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
          <span>Adjust</span>
        </DockIconTrigger>
      }
    >
      <div className="divide-y divide-white/[0.06]">
        <section aria-labelledby="create-presets-heading" className="p-1">
          <h3
            id="create-presets-heading"
            className="px-3 pt-3 text-xs font-medium uppercase tracking-wider text-neutral-500"
          >
            Presets
          </h3>
          <PresetsPanel
            mode={mode}
            presets={presetsForMode(mode)}
            onApply={handleApply}
            showHeading={false}
          />
        </section>
        <section aria-label="Advanced settings">
          <ImageSettingsPanel variant="sheet" />
        </section>
      </div>
    </Popover>
  );
});
