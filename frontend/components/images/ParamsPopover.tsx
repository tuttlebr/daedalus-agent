'use client';

import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import React, { memo } from 'react';

import { Popover } from '@/components/primitives';

import { ImageSettingsPanel } from './ImageSettingsPanel';
import { DockIconTrigger } from './PresetsPopover';

interface ParamsPopoverProps {
  disabled?: boolean;
  triggerClassName?: string;
}

export const ParamsPopover = memo(function ParamsPopover({
  disabled,
  triggerClassName,
}: ParamsPopoverProps) {
  return (
    <Popover
      position="top"
      align="start"
      sheetOnMobile
      trigger={
        <DockIconTrigger
          disabled={disabled}
          aria-label="Settings"
          className={triggerClassName}
        >
          <IconAdjustmentsHorizontal size={16} />
        </DockIconTrigger>
      }
    >
      <div className="w-full md:w-96 md:max-h-[70vh] md:overflow-y-auto">
        <ImageSettingsPanel variant="sheet" />
      </div>
    </Popover>
  );
});
