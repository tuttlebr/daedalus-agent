import { IconSearch, IconX } from '@tabler/icons-react';
import React, { useRef } from 'react';

import { IconButton, Input } from '@/components/primitives';

interface ViewToggleProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
}

export const ViewToggle: React.FC<ViewToggleProps> = ({
  searchTerm,
  onSearchChange,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-2">
      <Input
        ref={inputRef}
        aria-label="Search activity"
        value={searchTerm}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search activity..."
        leftIcon={<IconSearch size={18} aria-hidden="true" />}
        wrapperClassName="min-w-0 flex-1"
        size="sm"
      />
      {searchTerm && (
        <IconButton
          icon={<IconX size={18} />}
          aria-label="Clear activity search"
          onClick={() => {
            onSearchChange('');
            inputRef.current?.focus();
          }}
        />
      )}
    </div>
  );
};
