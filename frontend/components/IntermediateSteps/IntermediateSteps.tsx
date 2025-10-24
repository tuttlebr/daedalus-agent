import React, { useState, useMemo, useContext, useEffect } from 'react';
import {
  IntermediateStep,
  IntermediateStepCategory,
  getEventState,
  IntermediateStepState,
} from '@/types/intermediateSteps';
import { StepTimeline } from './StepTimeline';
import { ViewToggle } from './ViewToggle';
import { searchSteps, migrateOldStepFormat } from '@/utils/app/intermediateSteps';
import { loadIntermediateSteps, saveIntermediateSteps, getIntermediateStepCount } from '@/utils/app/intermediateStepsDB';
import HomeContext from '@/pages/api/home/home.context';

interface IntermediateStepsProps {
  steps: any[]; // Accept any[] to handle old format as well
  className?: string;
  conversationId?: string;
}

const INITIAL_STEPS_TO_SHOW = 5;
const STEPS_TO_LOAD_MORE = 10;

export const IntermediateSteps: React.FC<IntermediateStepsProps> = ({ steps, className = '', conversationId }) => {
  const {
    state: { intermediateStepsView, intermediateStepsFilter, messageIsStreaming, selectedConversation },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const [searchTerm, setSearchTerm] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [displayedSteps, setDisplayedSteps] = useState<IntermediateStep[]>([]);
  const [totalStepsCount, setTotalStepsCount] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadedCount, setLoadedCount] = useState(INITIAL_STEPS_TO_SHOW);

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

  // Save steps to IndexedDB when they change
  useEffect(() => {
    if (conversationId || selectedConversation?.id) {
      const convId = conversationId || selectedConversation?.id;
      if (convId && migratedSteps.length > 0) {
        saveIntermediateSteps(convId, migratedSteps).catch(console.error);
        setTotalStepsCount(migratedSteps.length);
      }
    }
  }, [migratedSteps, conversationId, selectedConversation?.id]);

  // Load initial steps
  useEffect(() => {
    const loadInitialSteps = async () => {
      if (!conversationId && !selectedConversation?.id) return;

      const convId = conversationId || selectedConversation?.id;
      if (!convId) return;

      try {
        const count = await getIntermediateStepCount(convId);
        setTotalStepsCount(count);

        // Show recent steps from props first, then load from DB if needed
        if (migratedSteps.length > 0) {
          setDisplayedSteps(migratedSteps.slice(-INITIAL_STEPS_TO_SHOW));
        } else if (count > 0) {
          const loaded = await loadIntermediateSteps(convId, 0, INITIAL_STEPS_TO_SHOW);
          setDisplayedSteps(loaded);
        }
      } catch (error) {
        console.error('Failed to load initial steps:', error);
      }
    };

    loadInitialSteps();
  }, [conversationId, selectedConversation?.id, migratedSteps]);

  // Apply search filter
  const filteredSteps = useMemo(() => {
    const stepsToFilter = displayedSteps.length > 0 ? displayedSteps : migratedSteps.slice(-INITIAL_STEPS_TO_SHOW);
    if (!searchTerm) return stepsToFilter;
    return searchSteps(stepsToFilter, searchTerm);
  }, [displayedSteps, migratedSteps, searchTerm]);

  const handleViewChange = (view: 'timeline' | 'category') => {
    homeDispatch({ field: 'intermediateStepsView', value: view });
  };

  const handleFilterChange = (filter: IntermediateStepCategory[]) => {
    homeDispatch({ field: 'intermediateStepsFilter', value: filter });
  };

  const handleLoadMore = async () => {
    if (isLoadingMore) return;

    const convId = conversationId || selectedConversation?.id;
    if (!convId) return;

    setIsLoadingMore(true);
    try {
      const moreSteps = await loadIntermediateSteps(convId, loadedCount, STEPS_TO_LOAD_MORE);
      setDisplayedSteps(prev => [...prev, ...moreSteps]);
      setLoadedCount(prev => prev + moreSteps.length);
    } catch (error) {
      console.error('Failed to load more steps:', error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const hasSteps = migratedSteps && migratedSteps.length > 0;
  const hasMoreSteps = loadedCount < totalStepsCount;

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

            {hasMoreSteps && !isLoadingMore && (
              <div className="p-4 flex justify-center">
                <button
                  onClick={handleLoadMore}
                  className="px-4 py-2 text-sm font-medium text-white/80 bg-white/10 hover:bg-white/20 rounded-lg transition-colors border border-white/10"
                >
                  Load {Math.min(STEPS_TO_LOAD_MORE, totalStepsCount - loadedCount)} More Steps
                </button>
              </div>
            )}

            {isLoadingMore && (
              <div className="p-4 flex justify-center">
                <div className="text-sm text-white/60">Loading more steps...</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
