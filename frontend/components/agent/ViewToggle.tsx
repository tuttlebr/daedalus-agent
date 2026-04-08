import React, { useState } from 'react';
import { IconSearch, IconX } from '@tabler/icons-react';

interface ViewToggleProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
}

export const ViewToggle: React.FC<ViewToggleProps> = ({
  searchTerm,
  onSearchChange,
}) => {
  const [showSearch, setShowSearch] = useState(false);

  return (
    <div className="flex items-center justify-end px-3 py-2">
      {showSearch ? (
        <div className="flex items-center gap-2 flex-1">
          <IconSearch size={14} className="text-white/30 flex-shrink-0" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search activity..."
            autoFocus
            className="
              flex-1 py-1 text-sm bg-transparent
              text-white placeholder-white/30
              focus:outline-none
            "
          />
          <button
            onClick={() => { onSearchChange(''); setShowSearch(false); }}
            className="p-1 hover:bg-white/10 rounded transition-colors text-white/40 hover:text-white/60"
          >
            <IconX size={14} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowSearch(true)}
          className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-white/30 hover:text-white/50"
          title="Search activity"
        >
          <IconSearch size={14} />
        </button>
      )}
    </div>
  );
};
