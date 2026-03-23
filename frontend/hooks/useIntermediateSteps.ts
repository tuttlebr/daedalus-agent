/**
 * useIntermediateSteps - Manages intermediate step merging for streaming chat
 *
 * Features:
 * - O(n) step merging using Map (instead of O(n²) array operations)
 * - Deduplication by UUID
 * - Timestamp-based ordering
 * - Filters out stale steps created after job completion
 * - Maintains insertion order for already-sorted data
 */

import { useCallback, useRef } from 'react';
import { IntermediateStep } from '@/types/intermediateSteps';
import { Logger } from '@/utils/logger';

const logger = new Logger('IntermediateSteps');

export interface UseIntermediateStepsOptions {
  /** Enable debug logging */
  debug?: boolean;
}

export interface UseIntermediateStepsReturn {
  /**
   * Merge incoming intermediate steps with existing steps.
   * Uses Map for O(n) complexity instead of O(n²) array operations.
   *
   * @param existingSteps - Current steps in the conversation
   * @param incomingSteps - New steps from stream or async job
   * @param completionTimestamp - Optional timestamp when job was finalized (filters stale steps)
   * @returns Merged and deduplicated steps, sorted by timestamp
   */
  mergeSteps: (
    existingSteps: IntermediateStep[],
    incomingSteps: IntermediateStep[],
    completionTimestamp?: number
  ) => IntermediateStep[];

  /**
   * Check if steps need sorting (optimization for pre-sorted data)
   */
  needsSort: (steps: IntermediateStep[]) => boolean;

  /**
   * Get step by UUID from a list
   */
  getStepByUUID: (steps: IntermediateStep[], uuid: string) => IntermediateStep | undefined;

  /**
   * Filter steps by event type pattern
   */
  filterStepsByType: (
    steps: IntermediateStep[],
    typePattern: string | RegExp
  ) => IntermediateStep[];

  /**
   * Get the last N steps (useful for UI truncation)
   */
  getLastNSteps: (steps: IntermediateStep[], n: number) => IntermediateStep[];

  /**
   * Clear the internal step cache (for conversation switching)
   */
  clearCache: () => void;
}

export function useIntermediateSteps(
  options: UseIntermediateStepsOptions = {}
): UseIntermediateStepsReturn {
  const { debug = false } = options;

  // Cache for frequently accessed steps (optional optimization)
  const stepCacheRef = useRef<Map<string, IntermediateStep>>(new Map());

  /**
   * Check if an array of steps is already sorted by timestamp
   */
  const needsSort = useCallback((steps: IntermediateStep[]): boolean => {
    if (steps.length <= 1) return false;

    for (let i = 1; i < steps.length; i++) {
      const prevTimestamp = steps[i - 1]?.payload?.event_timestamp ?? 0;
      const currTimestamp = steps[i]?.payload?.event_timestamp ?? 0;
      if (currTimestamp < prevTimestamp) {
        return true;
      }
    }
    return false;
  }, []);

  /**
   * Merge intermediate steps with O(n) complexity
   */
  const mergeSteps = useCallback(
    (
      existingSteps: IntermediateStep[] = [],
      incomingSteps: IntermediateStep[] = [],
      completionTimestamp?: number
    ): IntermediateStep[] => {
      // Fast path: no incoming steps
      if (!incomingSteps.length) {
        return existingSteps;
      }

      // Fast path: no existing steps
      if (!existingSteps.length) {
        const filtered = filterStaleSteps(incomingSteps, completionTimestamp);
        // Sort only if needed
        if (needsSort(filtered)) {
          return filtered.sort(
            (a, b) => (a.payload?.event_timestamp ?? 0) - (b.payload?.event_timestamp ?? 0)
          );
        }
        return filtered;
      }

      // Use Map for O(n) deduplication
      const stepsById = new Map<string, IntermediateStep>();

      // Add existing steps to map
      for (const step of existingSteps) {
        const uuid = step?.payload?.UUID;
        if (uuid) {
          stepsById.set(uuid, step);
        }
      }

      // Merge incoming steps
      for (const step of incomingSteps) {
        const uuid = step?.payload?.UUID;
        if (!uuid) {
          continue;
        }

        // Filter out steps that were created after job completion
        if (completionTimestamp && step.payload?.event_timestamp) {
          const completionTimestampSeconds = completionTimestamp / 1000;
          if (step.payload.event_timestamp > completionTimestampSeconds) {
            if (debug) {
              logger.warn('Filtering out stale intermediate step created after completion', {
                stepName: step.payload.name,
                stepTimestamp: step.payload.event_timestamp,
                completionTimestamp: completionTimestampSeconds,
              });
            }
            continue;
          }
        }

        const current = stepsById.get(uuid);
        if (current) {
          // Only update if the incoming step has newer data
          const shouldUpdate =
            !current.payload?.event_timestamp ||
            (step.payload?.event_timestamp &&
              step.payload.event_timestamp >= current.payload.event_timestamp);

          if (shouldUpdate) {
            stepsById.set(uuid, mergeStepData(current, step));
          }
        } else {
          stepsById.set(uuid, step);
        }
      }

      // Convert to array and sort
      const merged = Array.from(stepsById.values());

      // Optimization: skip sort if already sorted
      if (needsSort(merged)) {
        merged.sort(
          (a, b) => (a.payload?.event_timestamp ?? 0) - (b.payload?.event_timestamp ?? 0)
        );
      }

      return merged;
    },
    [needsSort, debug]
  );

  /**
   * Get step by UUID
   */
  const getStepByUUID = useCallback(
    (steps: IntermediateStep[], uuid: string): IntermediateStep | undefined => {
      return steps.find((step) => step?.payload?.UUID === uuid);
    },
    []
  );

  /**
   * Filter steps by event type
   */
  const filterStepsByType = useCallback(
    (steps: IntermediateStep[], typePattern: string | RegExp): IntermediateStep[] => {
      if (typeof typePattern === 'string') {
        return steps.filter((step) => step?.payload?.event_type === typePattern);
      }
      return steps.filter((step) =>
        step?.payload?.event_type && typePattern.test(step.payload.event_type)
      );
    },
    []
  );

  /**
   * Get the last N steps
   */
  const getLastNSteps = useCallback(
    (steps: IntermediateStep[], n: number): IntermediateStep[] => {
      if (steps.length <= n) return steps;
      return steps.slice(-n);
    },
    []
  );

  /**
   * Clear the step cache
   */
  const clearCache = useCallback(() => {
    stepCacheRef.current.clear();
  }, []);

  return {
    mergeSteps,
    needsSort,
    getStepByUUID,
    filterStepsByType,
    getLastNSteps,
    clearCache,
  };
}

/**
 * Helper: Merge two step objects, preserving data from both
 */
function mergeStepData(
  current: IntermediateStep,
  incoming: IntermediateStep
): IntermediateStep {
  return {
    ...current,
    ...incoming,
    function_ancestry: incoming.function_ancestry || current.function_ancestry,
    payload: {
      ...current.payload,
      ...incoming.payload,
      span_event_timestamp:
        incoming.payload?.span_event_timestamp ?? current.payload?.span_event_timestamp,
      metadata: incoming.payload?.metadata ?? current.payload?.metadata,
      data: incoming.payload?.data ?? current.payload?.data,
      usage_info: incoming.payload?.usage_info ?? current.payload?.usage_info,
    },
  };
}

/**
 * Helper: Filter out steps created after completion
 */
function filterStaleSteps(
  steps: IntermediateStep[],
  completionTimestamp?: number
): IntermediateStep[] {
  if (!completionTimestamp) {
    return steps;
  }

  const completionTimestampSeconds = completionTimestamp / 1000;
  return steps.filter((step) => {
    if (!step.payload?.event_timestamp) {
      return true; // Keep steps without timestamp
    }
    return step.payload.event_timestamp <= completionTimestampSeconds;
  });
}
