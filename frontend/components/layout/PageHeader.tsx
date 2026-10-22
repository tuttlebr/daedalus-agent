'use client';

import React from 'react';

import { ToolbarItems } from './ToolbarSlot';

import classNames from 'classnames';

export interface PageHeaderProps {
  title: React.ReactNode;
  /** Short status shown beside the title, such as Idle. */
  badge?: React.ReactNode;
  description?: React.ReactNode;
  /** The destination's commands. Wide windows place them in the toolbar. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The title block shared by every destination other than Chat, so switching
 * tabs keeps the same type, spacing and command placement.
 */
export function PageHeader({
  title,
  badge,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={classNames(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight text-primary">
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <div className="mt-1 text-sm text-secondary">{description}</div>
        )}
      </div>
      {actions && (
        <ToolbarItems>
          <div className="ml-auto flex flex-shrink-0 items-center gap-2">
            {actions}
          </div>
        </ToolbarItems>
      )}
    </header>
  );
}
