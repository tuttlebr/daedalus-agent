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
  const [isExpanded, setIsExpanded] = useState(false);

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

    // Deduplicate steps by UUID - when background processing is enabled,
    // the same steps might be sent multiple times
    const deduplicatedMap = new Map<string, IntermediateStep>();
    normalizedSteps.forEach((step) => {
      if (step?.payload?.UUID) {
        // If we already have this UUID, keep the one with the latest timestamp
        const existing = deduplicatedMap.get(step.payload.UUID);
        if (!existing || step.payload.event_timestamp > existing.payload.event_timestamp) {
          deduplicatedMap.set(step.payload.UUID, step);
        }
      }
    });

    return Array.from(deduplicatedMap.values())
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
      className={`apple-glass rounded-2xl overflow-hidden flex flex-col ${className}`}
    >
      <div className="sticky top-0 z-10">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="group w-full px-4 py-3 text-left text-sm font-medium text-white/90 hover:bg-white/5 transition-all flex items-center justify-between backdrop-blur-sm"
        >
          <span className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">Intermediate Steps</span>
            <span
              className={`inline-flex items-center gap-2 rounded-full px-2.5 py-0.5 text-xs font-semibold transition-all ${
                messageIsStreaming
                  ? 'bg-nvidia-green/20 text-nvidia-green border border-nvidia-green/30 shadow-[0_0_8px_rgba(118,185,0,0.3)]'
                  : 'bg-white/10 text-white/80 border border-white/20'
              }`}
            >
              {messageIsStreaming && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-nvidia-green opacity-75 animate-ping" aria-hidden />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-nvidia-green" />
                </span>
              )}
              <span>{visibleCount}</span>
            </span>
          </span>
          <svg
            className={`w-5 h-5 transition-transform duration-200 ease-out text-white/60 ${isExpanded ? 'rotate-180' : ''}`}
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
          <div className="h-0.5 bg-gradient-to-r from-transparent via-nvidia-green to-transparent animate-pulse" />
        )}
      </div>

      {isExpanded && (
        <div className="flex-1 flex flex-col min-h-0 animate-slide-in">
          <div className="sticky top-0 z-10 apple-glass-subtle border-b border-white/10">
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
