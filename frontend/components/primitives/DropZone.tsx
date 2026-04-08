'use client';

import React, { memo, useState, useCallback, useRef } from 'react';
import classNames from 'classnames';
import { IconUpload } from '@tabler/icons-react';

export interface DropZoneProps {
  onDrop: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export const DropZone = memo(({
  onDrop,
  accept,
  multiple = true,
  disabled = false,
  className = '',
  children,
}: DropZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items?.length) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    if (disabled) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length) onDrop(files);
  }, [disabled, onDrop]);

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={classNames(
        'relative transition-all duration-200',
        isDragging && !disabled && 'ring-2 ring-nvidia-green/50 bg-nvidia-green/5',
        className
      )}
    >
      {children}

      {/* Drag overlay */}
      {isDragging && !disabled && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-dark-bg-primary/80 backdrop-blur-sm rounded-xl border-2 border-dashed border-nvidia-green/60">
          <div className="flex flex-col items-center gap-2 text-nvidia-green">
            <IconUpload size={32} />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}
    </div>
  );
});

DropZone.displayName = 'DropZone';
