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
    <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2">
        {/* View Toggle */}
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          <button
            onClick={() => onViewChange('timeline')}
            className={`
              flex items-center gap-1 px-3 py-1 rounded text-sm transition-colors
              ${view === 'timeline'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }
            `}
          >
            <IconList size={16} />
            Timeline
          </button>
          <button
            onClick={() => onViewChange('category')}
            className={`
              flex items-center gap-1 px-3 py-1 rounded text-sm transition-colors
              ${view === 'category'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
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
              flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border transition-colors
              ${filter.length > 0
                ? 'border-nvidia-green text-nvidia-green dark:border-nvidia-green dark:text-nvidia-green'
                : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300'
              }
              hover:bg-gray-100 dark:hover:bg-gray-800
            `}
          >
            <IconFilter size={16} />
            Filter
            {filter.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-nvidia-green text-white rounded-full">
                {filter.length}
              </span>
            )}
          </button>

          {showFilterDropdown && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50">
              <div className="p-2">
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 px-2">
                  Event Categories
                </div>
                {allCategories.map(category => (
                  <label
                    key={category}
                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filter.includes(category)}
                      onChange={() => toggleCategory(category)}
                      className="rounded border-gray-300 dark:border-gray-600 text-nvidia-green focus:ring-nvidia-green"
                    />
                    <span className="text-sm">
                      {getCategoryDisplayName(category)}
                    </span>
                  </label>
                ))}
                <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
                  <button
                    onClick={() => onFilterChange([])}
                    className="w-full text-center text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
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
        <IconSearch size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search steps..."
          className="
            pl-9 pr-3 py-1.5 text-sm rounded-lg border
            border-gray-300 dark:border-gray-600
            bg-white dark:bg-gray-800
            text-gray-900 dark:text-white
            placeholder-gray-400 dark:placeholder-gray-500
            focus:outline-none focus:ring-2 focus:ring-nvidia-green focus:border-transparent
          "
        />
      </div>
    </div>
  );
};
