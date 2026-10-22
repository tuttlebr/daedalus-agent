import { IconChevronDown } from '@tabler/icons-react';
import React, { forwardRef } from 'react';

import classNames from 'classnames';

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
}

/** Keep the native picker and keyboard behavior, with consistent control sizing
 * across Safari, Chromium, and mobile. Native macOS appearance ignores padding
 * and minimum height on selects, so draw only the closed control ourselves. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ children, className, containerClassName, ...props }, ref) => (
    <div className={classNames('relative min-w-0', containerClassName)}>
      <select
        {...props}
        ref={ref}
        className={classNames(
          // Pointer devices use the 36px control height; touch keeps 44px.
          'block h-9 w-full min-w-0 appearance-none rounded-xl border border-separator/70 bg-control py-1.5 pl-3 pr-10 text-base text-primary md:text-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        {children}
      </select>
      <IconChevronDown
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-secondary"
      />
    </div>
  ),
);

Select.displayName = 'Select';
