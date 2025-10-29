import React, { useState, useEffect, useRef } from 'react';
import { IconDatabase, IconCheck, IconRefresh, IconAlertCircle } from '@tabler/icons-react';

interface CollectionSelectorProps {
  onSelect: (collection: string) => void;
  selectedCollection?: string;
  defaultCollection?: string;
  className?: string;
}

export const CollectionSelector: React.FC<CollectionSelectorProps> = ({
  onSelect,
  selectedCollection,
  defaultCollection,
  className = '',
}) => {
  const [collections, setCollections] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<'above' | 'below'>('below');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchCollections = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/milvus/collections');
      if (!response.ok) {
        throw new Error('Failed to fetch collections');
      }

      const data = await response.json();
      setCollections(data.collections || []);

      // If no collection is selected and there's a default, select it
      if (!selectedCollection && defaultCollection && data.collections.includes(defaultCollection)) {
        onSelect(defaultCollection);
      }
    } catch (err) {
      console.error('Error fetching collections:', err);
      setError('Failed to load collections');
      setCollections([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCollections();
  }, []);

  // Calculate dropdown position when opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - buttonRect.bottom;
      const spaceAbove = buttonRect.top;
      const dropdownHeight = 300; // Estimated max height

      // Position dropdown above if there's more space above and not enough below
      if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
        setDropdownPosition('above');
      } else {
        setDropdownPosition('below');
      }
    }
  }, [isOpen]);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        buttonRef.current &&
        dropdownRef.current &&
        !buttonRef.current.contains(event.target as Node) &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscapeKey);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEscapeKey);
      };
    }
  }, [isOpen]);

  const handleSelect = (collection: string) => {
    onSelect(collection);
    setIsOpen(false);
  };

  return (
    <div className={`relative ${className}`}>
      <div className="text-sm text-neutral-600 dark:text-white/70 mb-2 font-medium">Select target collection:</div>

      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg apple-glass backdrop-blur-md hover:bg-white/30 dark:hover:bg-white/15 border border-white/20 dark:border-white/10 transition-all text-neutral-700 dark:text-white/90 text-sm font-medium shadow-sm"
      >
        <div className="flex items-center gap-2">
          <IconDatabase size={16} className="text-neutral-600 dark:text-white/70" />
          <span>
            {selectedCollection || defaultCollection || 'Select collection...'}
          </span>
        </div>
        <svg
          className={`w-4 h-4 transition-transform duration-200 text-neutral-600 dark:text-white/70 ${isOpen ? 'rotate-180' : ''}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className={`absolute z-50 w-full rounded-lg apple-glass backdrop-blur-xl border border-white/20 dark:border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.24)] overflow-hidden ${
            dropdownPosition === 'above'
              ? 'bottom-full mb-2 animate-slide-up'
              : 'top-full mt-2 animate-slide-down'
          }`}
          style={{
            maxHeight: '300px',
          }}>
          <div className="flex items-center justify-between p-3 border-b border-white/20 dark:border-white/10 bg-white/5 dark:bg-white/5">
            <span className="text-xs font-medium text-neutral-700 dark:text-white/80 uppercase tracking-wider">
              Available Collections
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                fetchCollections();
              }}
              className="p-1 hover:bg-white/20 dark:hover:bg-white/10 rounded transition-colors"
              disabled={isLoading}
            >
              <IconRefresh size={14} className={`text-neutral-600 dark:text-white/60 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="max-h-48 overflow-y-auto bg-white/5 dark:bg-black/20">
            {error ? (
              <div className="p-3 flex items-center gap-2 text-red-500 dark:text-red-400 text-sm font-medium">
                <IconAlertCircle size={16} />
                <span>{error}</span>
              </div>
            ) : isLoading ? (
              <div className="p-3 text-center text-neutral-600 dark:text-white/60 text-sm font-medium">
                Loading collections...
              </div>
            ) : collections.length === 0 ? (
              <div className="p-3 text-center text-neutral-600 dark:text-white/60 text-sm font-medium">
                No collections found
              </div>
            ) : (
              <div className="py-1">
                {collections.map((collection) => (
                  <button
                    key={collection}
                    onClick={() => handleSelect(collection)}
                    className={`w-full px-3 py-2.5 text-left text-sm transition-all flex items-center justify-between group ${
                      selectedCollection === collection
                        ? 'bg-nvidia-green/20 dark:bg-nvidia-green/15 text-nvidia-green dark:text-nvidia-green font-semibold'
                        : 'text-neutral-700 dark:text-white/90 hover:bg-white/20 dark:hover:bg-white/10 font-medium'
                    }`}
                  >
                    <span>{collection}</span>
                    {selectedCollection === collection && (
                      <IconCheck size={16} className="text-nvidia-green" />
                    )}
                  </button>
                ))}

                {/* Option to create new collection with username */}
                {defaultCollection && !collections.includes(defaultCollection) && (
                  <button
                    onClick={() => handleSelect(defaultCollection)}
                    className="w-full px-3 py-2.5 text-left text-sm hover:bg-white/20 dark:hover:bg-white/10 transition-all flex items-center justify-between group text-neutral-600 dark:text-white/70 border-t border-white/20 dark:border-white/10 font-medium"
                  >
                    <span className="italic">Create new: {defaultCollection}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
