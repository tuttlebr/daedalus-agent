import {
  IconChevronRight,
  IconChevronDown,
  IconBrain,
  IconTool,
  IconGitBranch,
  IconCheck,
  IconLoader2,
} from '@tabler/icons-react';
import React, { useState, useMemo, useId } from 'react';

import {
  consolidateSteps,
  ConsolidatedStep,
  formatDuration,
} from '@/utils/app/intermediateSteps';

import {
  IntermediateStep,
  IntermediateStepCategory,
} from '@/types/intermediateSteps';

import { ModalSurface } from '@/components/surfaces';

import { StepDetails } from './StepDetails';

interface StepTimelineProps {
  steps: IntermediateStep[];
  isStreaming: boolean;
  isSearching?: boolean;
}

export const StepTimeline: React.FC<StepTimelineProps> = ({
  steps,
  isStreaming,
  isSearching = false,
}) => {
  const timelineId = useId();
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedStep, setSelectedStep] = useState<ConsolidatedStep | null>(
    null,
  );

  const consolidated = useMemo(
    () => consolidateSteps(steps, !isStreaming),
    [steps, isStreaming],
  );

  const showSkeleton = isStreaming && consolidated.length === 0;
  const showEmptyState = !isStreaming && consolidated.length === 0;

  const getCategoryIcon = (
    category: IntermediateStepCategory,
    status: 'active' | 'completed',
  ) => {
    if (status === 'active') {
      return <IconLoader2 size={16} className="animate-spin" />;
    }
    switch (category) {
      case IntermediateStepCategory.LLM:
        return <IconBrain size={16} />;
      case IntermediateStepCategory.TOOL:
        return <IconTool size={16} />;
      case IntermediateStepCategory.WORKFLOW:
        return <IconGitBranch size={16} />;
      default:
        return <IconCheck size={16} />;
    }
  };

  const getCategoryColor = (
    category: IntermediateStepCategory,
    status: 'active' | 'completed',
  ) => {
    if (status === 'active') return 'text-nvidia-green';
    switch (category) {
      case IntermediateStepCategory.LLM:
        return 'text-nvidia-blue';
      case IntermediateStepCategory.TOOL:
        return 'text-nvidia-teal';
      case IntermediateStepCategory.WORKFLOW:
        return 'text-nvidia-purple';
      default:
        return 'text-muted';
    }
  };

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
    const isExpanded = expandedNodes.has(step.id);
    const hasChildren = step.children.length > 0;
    const isActive = step.status === 'active';

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
              setSelectedStep(step);
            }}
          >
            {/* Category icon */}
            <span
              aria-hidden="true"
              className={`mt-1 flex-shrink-0 ${getCategoryColor(
                step.category,
                step.status,
              )}`}
            >
              {getCategoryIcon(step.category, step.status)}
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
            </span>

            {/* Duration or active indicator */}
            <span className="flex-shrink-0 ml-auto">
              {isActive ? (
                <span className="text-xs text-nvidia-green font-medium">
                  working...
                </span>
              ) : step.duration ? (
                <span className="text-xs text-muted">
                  {formatDuration(step.duration)}
                </span>
              ) : null}
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
        {isSearching
          ? 'No activity matches your search.'
          : 'No activity recorded yet.'}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="min-w-0 py-2 px-1 space-y-0.5">
        {consolidated.map((step) => renderStep(step))}
      </div>

      {selectedStep && (
        <ModalSurface
          open
          onClose={() => setSelectedStep(null)}
          aria-label={`${selectedStep.friendlyName} details`}
          className="w-full max-w-3xl rounded-2xl border border-separator bg-panel"
        >
          <StepDetails
            consolidatedStep={selectedStep}
            onClose={() => setSelectedStep(null)}
          />
        </ModalSurface>
      )}
    </div>
  );
};
