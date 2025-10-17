import React, { useState } from 'react';
import {
  IconList,
  IconCategory,
  IconFilter,
  IconSearch
} from '@tabler/icons-react';
import { IntermediateStepCategory } from '@/types/intermediateSteps';

interface ViewToggleProps {
  view: 'timeline' | 'category';
  onViewChange: (view: 'timeline' | 'category') => void;
  filter: IntermediateStepCategory[];
  onFilterChange: (filter: IntermediateStepCategory[]) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
}

export const ViewToggle: React.FC<ViewToggleProps> = ({
  view,
  onViewChange,
  filter,
  onFilterChange,
  searchTerm,
  onSearchChange
}) => {
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);

  const allCategories = Object.values(IntermediateStepCategory);

  const toggleCategory = (category: IntermediateStepCategory) => {
    if (filter.includes(category)) {
      onFilterChange(filter.filter(c => c !== category));
    } else {
      onFilterChange([...filter, category]);
    }
  };

  const getCategoryDisplayName = (category: IntermediateStepCategory) => {
    return category.charAt(0) + category.slice(1).toLowerCase();
  };

  return (
    <div className="flex items-center justify-between p-3">
      <div className="flex items-center gap-2">
        {/* View Toggle */}
        <div className="flex bg-white/10 backdrop-blur-sm rounded-lg p-1">
          <button
            onClick={() => onViewChange('timeline')}
            className={`
              flex items-center gap-1 px-3 py-1 rounded text-sm transition-all
              ${view === 'timeline'
                ? 'bg-white/20 text-white shadow-sm'
                : 'text-white/60 hover:text-white/80 hover:bg-white/10'
              }
            `}
          >
            <IconList size={16} />
            Timeline
          </button>
          <button
            onClick={() => onViewChange('category')}
            className={`
              flex items-center gap-1 px-3 py-1 rounded text-sm transition-all
              ${view === 'category'
                ? 'bg-white/20 text-white shadow-sm'
                : 'text-white/60 hover:text-white/80 hover:bg-white/10'
              }
            `}
          >
            <IconCategory size={16} />
            Category
          </button>
        </div>

        {/* Filter Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            className={`
              flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border transition-all
              ${filter.length > 0
                ? 'border-nvidia-green/40 text-nvidia-green bg-nvidia-green/10'
                : 'border-white/20 text-white/60 hover:text-white/80'
              }
              hover:bg-white/10
            `}
          >
            <IconFilter size={16} />
            Filter
            {filter.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-nvidia-green text-black rounded-full font-medium">
                {filter.length}
              </span>
            )}
          </button>

          {showFilterDropdown && (
            <div className="absolute top-full left-0 mt-1 w-48 apple-glass rounded-lg shadow-xl z-50">
              <div className="p-2">
                <div className="text-xs font-semibold text-white/40 mb-2 px-2 uppercase tracking-wider">
                  Event Categories
                </div>
                {allCategories.map(category => (
                  <label
                    key={category}
                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/10 rounded cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={filter.includes(category)}
                      onChange={() => toggleCategory(category)}
                      className="rounded border-white/20 bg-white/10 text-nvidia-green focus:ring-nvidia-green focus:ring-offset-0"
                    />
                    <span className="text-sm text-white/80">
                      {getCategoryDisplayName(category)}
                    </span>
                  </label>
                ))}
                <div className="border-t border-white/10 mt-2 pt-2">
                  <button
                    onClick={() => onFilterChange([])}
                    className="w-full text-center text-xs text-white/40 hover:text-white/60 transition-colors"
                  >
                    Clear all
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Search Input */}
      <div className="relative">
        <IconSearch size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-white/40" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search steps..."
          className="
            pl-9 pr-3 py-1.5 text-sm rounded-lg
            bg-white/10 backdrop-blur-sm border border-white/20
            text-white placeholder-white/40
            focus:outline-none focus:bg-white/15 focus:border-nvidia-green/40
            transition-all
          "
        />
      </div>
    </div>
  );
};
