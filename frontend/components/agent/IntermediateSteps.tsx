import React, { useState, useMemo, useEffect } from 'react';
import {
  IntermediateStep,
  getEventState,
  IntermediateStepState,
} from '@/types/intermediateSteps';
import { StepTimeline } from './StepTimeline';
import { ViewToggle } from './ViewToggle';
import { searchSteps, migrateOldStepFormat, consolidateSteps, searchConsolidatedSteps } from '@/utils/app/intermediateSteps';
import { loadIntermediateSteps, saveIntermediateSteps, getIntermediateStepCount } from '@/utils/app/intermediateStepsDB';
import { useConversationStore, useUISettingsStore } from '@/state';
import { Logger } from '@/utils/logger';

const logger = new Logger('IntermediateSteps');

interface IntermediateStepsProps {
  steps: any[];
  className?: string;
  conversationId?: string;
}

const INITIAL_STEPS_TO_SHOW = 5;
const STEPS_TO_LOAD_MORE = 10;

export const IntermediateSteps: React.FC<IntermediateStepsProps> = ({ steps, className = '', conversationId }) => {
  const selectedConversationId = useConversationStore((s) => s.selectedConversationId);
  const streamingConversationIds = useConversationStore((s) => s.streamingConversationIds);
  const activeConversationId = conversationId || selectedConversationId;
  const resolvedIsStreaming = Boolean(
    activeConversationId && streamingConversationIds.has(activeConversationId)
  );

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

    // Deduplicate steps by UUID
    const deduplicatedMap = new Map<string, IntermediateStep>();
    normalizedSteps.forEach((step) => {
      if (step?.payload?.UUID) {
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
    if (conversationId || selectedConversationId) {
      const convId = conversationId || selectedConversationId;
      if (convId && migratedSteps.length > 0) {
        saveIntermediateSteps(convId, migratedSteps).catch(err => logger.error('Failed to save intermediate steps:', err));
        setTotalStepsCount(migratedSteps.length);
        setDisplayedSteps(migratedSteps);
        setLoadedCount(migratedSteps.length);
      }
    }
  }, [migratedSteps, conversationId, selectedConversationId]);

  // Load initial steps from DB only when switching conversations
  useEffect(() => {
    const loadInitialSteps = async () => {
      if (!conversationId && !selectedConversationId) return;

      const convId = conversationId || selectedConversationId;
      if (!convId) return;

      if (migratedSteps.length === 0) {
        try {
          const count = await getIntermediateStepCount(convId);
          setTotalStepsCount(count);

          if (count > 0) {
            const loaded = await loadIntermediateSteps(convId, Math.max(0, count - INITIAL_STEPS_TO_SHOW), INITIAL_STEPS_TO_SHOW);
            setDisplayedSteps(loaded);
            setLoadedCount(loaded.length);
          }
        } catch (error) {
          logger.error('Failed to load initial steps:', error);
        }
      }
    };

    loadInitialSteps();
  }, [conversationId, selectedConversationId, migratedSteps.length]);

  // Consolidated count for the badge
  const consolidatedCount = useMemo(() => {
    return consolidateSteps(displayedSteps, !resolvedIsStreaming).length;
  }, [displayedSteps, resolvedIsStreaming]);

  const handleLoadMore = async () => {
    if (isLoadingMore) return;

    const convId = conversationId || selectedConversationId;
    if (!convId) return;

    setIsLoadingMore(true);
    try {
      const startIndex = Math.max(0, totalStepsCount - loadedCount - STEPS_TO_LOAD_MORE);
      const countToLoad = Math.min(STEPS_TO_LOAD_MORE, totalStepsCount - loadedCount);

      const olderSteps = await loadIntermediateSteps(convId, startIndex, countToLoad);

      const existingUUIDs = new Set(displayedSteps.map(s => s.payload?.UUID).filter(Boolean));
      const newSteps = olderSteps.filter(step => !existingUUIDs.has(step.payload?.UUID));

      setDisplayedSteps(prev => [...newSteps, ...prev]);
      setLoadedCount(prev => prev + newSteps.length);
    } catch (error) {
      logger.error('Failed to load more steps:', error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const hasSteps = migratedSteps && migratedSteps.length > 0;
  const hasMoreSteps = migratedSteps.length === 0 && loadedCount < totalStepsCount;

  if (!hasSteps && !resolvedIsStreaming) {
    return null;
  }

  return (
    <div
      className={`apple-glass rounded-2xl overflow-hidden flex flex-col max-h-[40vh] sm:max-h-[50vh] ${className}`}
    >
      <div className="sticky top-0 z-10">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="group w-full px-3 py-2 sm:px-4 sm:py-2.5 text-left text-sm font-medium text-white/90 hover:bg-white/5 transition-all flex items-center justify-between backdrop-blur-sm"
        >
          <span className="flex items-center gap-2.5">
            <span className="text-sm font-semibold tracking-tight">Agent Activity</span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-all ${
                resolvedIsStreaming
                  ? 'bg-nvidia-green/15 text-nvidia-green border border-nvidia-green/20'
                  : 'bg-white/10 text-white/60 border border-white/10'
              }`}
            >
              {resolvedIsStreaming && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-nvidia-green opacity-75 animate-ping" aria-hidden />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-nvidia-green" />
                </span>
              )}
              <span>{consolidatedCount}</span>
            </span>
          </span>
          <svg
            className={`w-4 h-4 transition-transform duration-200 ease-out text-white/40 ${isExpanded ? 'rotate-180' : ''}`}
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
        {resolvedIsStreaming && (
          <div className="h-0.5 bg-gradient-to-r from-transparent via-nvidia-green to-transparent animate-pulse" />
        )}
      </div>

      {isExpanded && (
        <div className="flex-1 flex flex-col min-h-0 animate-slide-in">
          <div className="sticky top-0 z-10 border-b border-white/[0.06]">
            <ViewToggle
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <StepTimeline
              steps={searchTerm ? searchSteps(displayedSteps, searchTerm) : displayedSteps}
              isStreaming={resolvedIsStreaming}
            />

            {hasMoreSteps && !isLoadingMore && (
              <div className="p-3 flex justify-center">
                <button
                  onClick={handleLoadMore}
                  className="px-3 py-1.5 text-xs font-medium text-white/50 bg-white/[0.06] hover:bg-white/10 rounded-lg transition-colors border border-white/[0.06]"
                >
                  Load {Math.min(STEPS_TO_LOAD_MORE, totalStepsCount - loadedCount)} older
                </button>
              </div>
            )}

            {isLoadingMore && (
              <div className="p-3 flex justify-center">
                <div className="text-xs text-white/40">Loading...</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
