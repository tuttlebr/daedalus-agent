import React, { useState, useMemo, useContext } from 'react';
import {
  IntermediateStep,
  IntermediateStepCategory,
  getEventState,
  IntermediateStepState,
} from '@/types/intermediateSteps';
import { StepTimeline } from './StepTimeline';
import { ViewToggle } from './ViewToggle';
import { searchSteps, migrateOldStepFormat } from '@/utils/app/intermediateSteps';
import HomeContext from '@/pages/api/home/home.context';

interface IntermediateStepsProps {
  steps: any[]; // Accept any[] to handle old format as well
  className?: string;
}

export const IntermediateSteps: React.FC<IntermediateStepsProps> = ({ steps, className = '' }) => {
  const {
    state: { intermediateStepsView, intermediateStepsFilter, messageIsStreaming },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const [searchTerm, setSearchTerm] = useState('');
  const [isExpanded, setIsExpanded] = useState(true);

  // Migrate old steps to new format if needed
  const migratedSteps = useMemo(() => {
    if (!steps || steps.length === 0) return [];

    let normalizedSteps: IntermediateStep[];

    if (steps[0]?.payload?.event_type) {
      normalizedSteps = steps as IntermediateStep[];
    } else {
      const migrated = steps
        .map((step) => migrateOldStepFormat(step))
        .filter((step) => step !== null) as IntermediateStep[];
      normalizedSteps = migrated;
    }

    return normalizedSteps
      .filter((step) => {
        if (!step?.payload?.event_type) {
          return false;
        }
        return getEventState(step.payload.event_type) !== IntermediateStepState.CHUNK;
      })
      .sort((a, b) => a.payload.event_timestamp - b.payload.event_timestamp);
  }, [steps]);

  // Apply search filter
  const filteredSteps = useMemo(() => {
    if (!searchTerm) return migratedSteps;
    return searchSteps(migratedSteps, searchTerm);
  }, [migratedSteps, searchTerm]);

  const handleViewChange = (view: 'timeline' | 'category') => {
    homeDispatch({ field: 'intermediateStepsView', value: view });
  };

  const handleFilterChange = (filter: IntermediateStepCategory[]) => {
    homeDispatch({ field: 'intermediateStepsFilter', value: filter });
  };

  const hasSteps = migratedSteps && migratedSteps.length > 0;

  if (!hasSteps && !messageIsStreaming) {
    return null;
  }

  const visibleCount = filteredSteps.length;

  return (
    <div
      className={`border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden flex flex-col ${className}`}
    >
      <div className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="group w-full px-4 py-2 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center justify-between"
        >
          <span className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">Intermediate Steps</span>
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${
                messageIsStreaming
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              {messageIsStreaming && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400/70 opacity-75 animate-ping" aria-hidden />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
              )}
              <span>{visibleCount}</span>
            </span>
          </span>
          <svg
            className={`w-5 h-5 transition-transform duration-200 ease-out ${isExpanded ? 'rotate-180' : 'group-hover:translate-x-0.5'}`}
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
        {messageIsStreaming && (
          <div className="h-1 bg-gradient-to-r from-nvidia-green via-emerald-400 to-nvidia-green animate-pulse" />
        )}
      </div>

      {isExpanded && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <ViewToggle
              view={intermediateStepsView}
              onViewChange={handleViewChange}
              filter={intermediateStepsFilter}
              onFilterChange={handleFilterChange}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <StepTimeline
              steps={filteredSteps}
              view={intermediateStepsView}
              filter={intermediateStepsFilter}
              onFilterChange={handleFilterChange}
              isStreaming={Boolean(messageIsStreaming)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
