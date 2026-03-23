import React, { useState, useMemo } from 'react';
import {
  IconChevronRight,
  IconChevronDown,
  IconBrain,
  IconTool,
  IconGitBranch,
  IconSearch as IconSearchIcon,
  IconCheck,
  IconLoader2,
} from '@tabler/icons-react';
import {
  IntermediateStep,
  IntermediateStepCategory,
} from '@/types/intermediateSteps';
import {
  consolidateSteps,
  ConsolidatedStep,
  formatDuration,
  searchConsolidatedSteps,
} from '@/utils/app/intermediateSteps';
import { StepDetails } from './StepDetails';

interface StepTimelineProps {
  steps: IntermediateStep[];
  isStreaming: boolean;
}

export const StepTimeline: React.FC<StepTimelineProps> = ({
  steps,
  isStreaming,
}) => {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedStep, setSelectedStep] = useState<ConsolidatedStep | null>(null);

  const consolidated = useMemo(() => consolidateSteps(steps, !isStreaming), [steps, isStreaming]);

  const showSkeleton = isStreaming && consolidated.length === 0;
  const showEmptyState = !isStreaming && consolidated.length === 0;

  const getCategoryIcon = (category: IntermediateStepCategory, status: 'active' | 'completed') => {
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

  const getCategoryColor = (category: IntermediateStepCategory, status: 'active' | 'completed') => {
    if (status === 'active') return 'text-nvidia-green';
    switch (category) {
      case IntermediateStepCategory.LLM:
        return 'text-blue-400';
      case IntermediateStepCategory.TOOL:
        return 'text-emerald-400';
      case IntermediateStepCategory.WORKFLOW:
        return 'text-purple-400';
      default:
        return 'text-white/50';
    }
  };

  const toggleNode = (id: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const renderStep = (step: ConsolidatedStep, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedNodes.has(step.id);
    const hasChildren = step.children.length > 0;
    const isActive = step.status === 'active';

    return (
      <div key={step.id} className="group/step">
        <div
          role="button"
          tabIndex={0}
          className={`
            flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer
            transition-all duration-150
            ${selectedStep?.id === step.id
              ? 'bg-white/15 shadow-[0_0_8px_rgba(118,185,0,0.15)]'
              : 'hover:bg-white/[0.07]'}
            ${isActive ? 'bg-nvidia-green/[0.06]' : ''}
          `}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => setSelectedStep(step)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedStep(step); } }}
        >
          {/* Expand/collapse for children */}
          {hasChildren ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggleNode(step.id); }}
              className="p-0.5 hover:bg-white/15 rounded transition-all flex-shrink-0"
            >
              {isExpanded
                ? <IconChevronDown size={14} className="text-white/50" />
                : <IconChevronRight size={14} className="text-white/50" />}
            </button>
          ) : (
            <div className="w-[18px] flex-shrink-0" />
          )}

          {/* Category icon */}
          <span className={`flex-shrink-0 ${getCategoryColor(step.category, step.status)}`}>
            {getCategoryIcon(step.category, step.status)}
          </span>

          {/* Name and context */}
          <div className="flex-1 min-w-0">
            <span className={`text-sm font-medium ${isActive ? 'text-white/95' : 'text-white/80'}`}>
              {step.friendlyName}
            </span>
            {step.context && (
              <span className="ml-2 text-xs text-white/40 truncate inline-block max-w-[200px] align-middle">
                {step.context}
              </span>
            )}
          </div>

          {/* Duration or active indicator */}
          <div className="flex-shrink-0 ml-auto">
            {isActive ? (
              <span className="text-xs text-nvidia-green font-medium">working...</span>
            ) : step.duration ? (
              <span className="text-xs text-white/30">{formatDuration(step.duration)}</span>
            ) : null}
          </div>
        </div>

        {/* Children */}
        {isExpanded && hasChildren && (
          <div className="mt-0.5">
            {step.children.map(child => renderStep(child, depth + 1))}
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
            <div className="w-4 h-4 rounded bg-white/10 animate-pulse" />
            <div className="h-4 rounded bg-white/10 animate-pulse flex-1" />
            <div className="w-12 h-4 rounded bg-white/10 animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (showEmptyState) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-white/40">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 min-h-0 py-2 px-1 space-y-0.5">
        {consolidated.map(step => renderStep(step))}
      </div>

      {selectedStep && (
        <div className="w-full md:w-96 lg:w-[28rem] xl:w-[32rem] 2xl:w-[36rem] max-w-[40rem] border-l border-white/10 overflow-y-auto apple-glass-subtle">
          <StepDetails
            consolidatedStep={selectedStep}
            onClose={() => setSelectedStep(null)}
          />
        </div>
      )}
    </div>
  );
};
