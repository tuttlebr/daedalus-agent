import { IconChevronRight, IconChevronDown } from '@tabler/icons-react';
import React, { useState, useMemo, useId } from 'react';

import {
  consolidateSteps,
  ConsolidatedStep,
  formatDuration,
  flattenSteps,
  getOutcomeSummary,
  OPERATION_LABELS,
} from '@/utils/app/intermediateSteps';

import { IntermediateStep } from '@/types/intermediateSteps';

import { ModalSurface } from '@/components/surfaces';

import { ActivityIcon } from './ActivityIcon';
import { StepDetails } from './StepDetails';

interface StepTimelineProps {
  steps: IntermediateStep[];
  isStreaming: boolean;
  isSearching?: boolean;
  searchTerm?: string;
}

export const StepTimeline: React.FC<StepTimelineProps> = ({
  steps,
  isStreaming,
  isSearching = false,
  searchTerm = '',
}) => {
  const timelineId = useId();
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const consolidated = useMemo(
    () => consolidateSteps(steps, !isStreaming),
    [steps, isStreaming],
  );

  const allOperations = useMemo(
    () => flattenSteps(consolidated),
    [consolidated],
  );
  const selectedStep = allOperations.find((step) => step.id === selectedStepId);
  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return consolidated;
    const filter = (nodes: ConsolidatedStep[]): ConsolidatedStep[] =>
      nodes.flatMap((node) => {
        const children = filter(node.children);
        const matches = `${node.friendlyName} ${
          node.context || ''
        } ${getOutcomeSummary(node)}`
          .toLowerCase()
          .includes(term);
        return matches
          ? [node]
          : children.length
          ? [{ ...node, children }]
          : [];
      });
    return filter(consolidated);
  }, [consolidated, searchTerm]);
  const showSkeleton = isStreaming && consolidated.length === 0;
  const showEmptyState = filtered.length === 0 && !showSkeleton;

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const renderStep = (
    step: ConsolidatedStep,
    depth: number = 0,
  ): React.ReactNode => {
    const isExpanded = expandedNodes.has(step.id) || Boolean(searchTerm.trim());
    const hasChildren = step.children.length > 0;
    const isActive = step.status === 'active' || step.status === 'retrying';

    return (
      <div key={step.id} className="group/step">
        <div
          className={`
            flex min-w-0 items-center gap-1 rounded-lg
            ${isActive ? 'bg-nvidia-green/[0.06]' : ''}
          `}
          style={{ paddingInlineStart: `${Math.min(depth, 3) * 12}px` }}
        >
          {/* Expand/collapse for children */}
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isExpanded ? 'Hide' : 'Show'} ${
                step.friendlyName
              } steps`}
              aria-expanded={isExpanded}
              aria-controls={`${timelineId}-${step.id}`}
              onClick={() => toggleNode(step.id)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-fill/10"
            >
              {isExpanded ? (
                <IconChevronDown size={18} aria-hidden="true" />
              ) : (
                <IconChevronRight size={18} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="w-2 flex-shrink-0" aria-hidden="true" />
          )}

          <button
            type="button"
            aria-label={`View ${step.friendlyName} details`}
            aria-haspopup="dialog"
            className="flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-3 text-left hover:bg-fill/5"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              setSelectedStepId(step.id);
            }}
          >
            {/* Category icon */}
            <span
              aria-hidden="true"
              className={`mt-1 flex-shrink-0 ${
                step.status === 'failed'
                  ? 'text-error'
                  : isActive
                  ? 'text-primary motion-safe:animate-pulse'
                  : 'text-muted'
              }`}
            >
              <ActivityIcon step={step} status={step.status} />
            </span>

            {/* Name and context */}
            <span className="flex-1 min-w-0 break-words">
              <span
                className={`text-sm font-medium ${
                  isActive ? 'text-primary' : 'text-secondary'
                }`}
              >
                {step.friendlyName}
              </span>
              {step.context && (
                <span className="mt-1 block text-xs text-muted">
                  {step.context}
                </span>
              )}
              {step.endStep && (
                <span className="mt-1 block text-xs text-muted">
                  {getOutcomeSummary(step)}
                </span>
              )}
            </span>

            <span className="ml-auto flex-shrink-0 text-right text-xs text-muted">
              <span
                className={step.status === 'failed' ? 'text-error' : undefined}
              >
                {OPERATION_LABELS[step.status]}
              </span>
              {step.duration !== undefined && (
                <span className="mt-1 block tabular-nums">
                  {formatDuration(step.duration)}
                </span>
              )}
            </span>
          </button>
        </div>

        {/* Children */}
        {isExpanded && hasChildren && (
          <div id={`${timelineId}-${step.id}`} className="mt-0.5">
            {step.children.map((child) => renderStep(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (showSkeleton) {
    return (
      <div className="p-4 space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <div className="w-4 h-4 rounded bg-fill/10 animate-pulse" />
            <div className="h-4 rounded bg-fill/10 animate-pulse flex-1" />
            <div className="w-12 h-4 rounded bg-fill/10 animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (showEmptyState) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted">
        {isSearching || searchTerm.trim()
          ? 'No activity matches your search.'
          : 'No activity recorded yet.'}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="min-w-0 py-2 px-1 space-y-0.5">
        {filtered.map((step) => renderStep(step))}
      </div>

      {selectedStep && (
        <ModalSurface
          open
          onClose={() => setSelectedStepId(null)}
          aria-label={`${selectedStep.friendlyName} details`}
          className="flex max-h-[80dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-separator bg-panel"
        >
          <StepDetails
            key={selectedStep.id}
            consolidatedStep={selectedStep}
            onClose={() => setSelectedStepId(null)}
          />
        </ModalSurface>
      )}
    </div>
  );
};
