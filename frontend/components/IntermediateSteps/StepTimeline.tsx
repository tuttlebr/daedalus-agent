import React, { useState, useMemo } from 'react';
import {
  IconChevronRight,
  IconChevronDown,
  IconBrain,
  IconTool,
  IconGitBranch,
  IconCheckbox,
  IconFunction,
  IconSettings,
  IconActivity
} from '@tabler/icons-react';
import {
  IntermediateStep,
  IntermediateStepCategory,
  IntermediateStepState,
  getEventCategory,
  getEventState
} from '@/types/intermediateSteps';
import { StepDetails } from './StepDetails';

interface StepTimelineProps {
  steps: IntermediateStep[];
  view: 'timeline' | 'category';
  filter: IntermediateStepCategory[];
  onFilterChange: (filter: IntermediateStepCategory[]) => void;
  isStreaming: boolean;
}

interface StepNode {
  step: IntermediateStep;
  children: StepNode[];
  duration?: number;
}

export const StepTimeline: React.FC<StepTimelineProps> = ({
  steps,
  view,
  filter,
  onFilterChange,
  isStreaming,
}) => {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedStep, setSelectedStep] = useState<IntermediateStep | null>(null);

  const showSkeleton = isStreaming && steps.length === 0;
  const showEmptyState = !isStreaming && steps.length === 0;

  const sortedSteps = useMemo(() => {
    return [...steps].sort(
      (a, b) => a.payload.event_timestamp - b.payload.event_timestamp,
    );
  }, [steps]);

  // Build hierarchical structure from steps
  const stepHierarchy = useMemo(() => {
    const nodeMap = new Map<string, StepNode>();
    const rootNodes: StepNode[] = [];

    sortedSteps.forEach((step) => {
      nodeMap.set(step.payload.UUID, { step, children: [] });
    });

    // Second pass: build hierarchy and calculate durations
    sortedSteps.forEach((step) => {
      const node = nodeMap.get(step.payload.UUID);
      if (!node) return;

      // Calculate duration for END events
      if (
        getEventState(step.payload.event_type) === IntermediateStepState.END &&
        step.payload.span_event_timestamp
      ) {
        node.duration =
          step.payload.event_timestamp - step.payload.span_event_timestamp;
      }

      // Add to parent or root
      if (step.parent_id === 'root') {
        rootNodes.push(node);
      } else {
        const parentNode = nodeMap.get(step.parent_id);
        if (parentNode) {
          parentNode.children.push(node);
        } else {
          rootNodes.push(node); // Fallback to root if parent not found
        }
      }
    });

    return rootNodes;
  }, [sortedSteps]);

  // Group steps by category for category view
  const stepsByCategory = useMemo(() => {
    const grouped = new Map<IntermediateStepCategory, IntermediateStep[]>();

    sortedSteps.forEach((step) => {
      const category = getEventCategory(step.payload.event_type);
      if (!filter.length || filter.includes(category)) {
        const categorySteps = grouped.get(category) || [];
        categorySteps.push(step);
        grouped.set(category, categorySteps);
      }
    });

    grouped.forEach((categorySteps, category) => {
      categorySteps.sort((a, b) => a.payload.event_timestamp - b.payload.event_timestamp);
      grouped.set(category, categorySteps);
    });

    return grouped;
  }, [sortedSteps, filter]);

  const getCategoryIcon = (category: IntermediateStepCategory) => {
    switch (category) {
      case IntermediateStepCategory.LLM:
        return <IconBrain size={16} />;
      case IntermediateStepCategory.TOOL:
        return <IconTool size={16} />;
      case IntermediateStepCategory.WORKFLOW:
        return <IconGitBranch size={16} />;
      case IntermediateStepCategory.TASK:
        return <IconCheckbox size={16} />;
      case IntermediateStepCategory.FUNCTION:
        return <IconFunction size={16} />;
      case IntermediateStepCategory.CUSTOM:
        return <IconSettings size={16} />;
      case IntermediateStepCategory.SPAN:
        return <IconActivity size={16} />;
      default:
        return <IconSettings size={16} />;
    }
  };

  const getCategoryColor = (category: IntermediateStepCategory) => {
    switch (category) {
      case IntermediateStepCategory.LLM:
        return 'text-blue-500 dark:text-blue-400';
      case IntermediateStepCategory.TOOL:
        return 'text-green-500 dark:text-green-400';
      case IntermediateStepCategory.WORKFLOW:
        return 'text-purple-500 dark:text-purple-400';
      case IntermediateStepCategory.TASK:
        return 'text-orange-500 dark:text-orange-400';
      case IntermediateStepCategory.FUNCTION:
        return 'text-pink-500 dark:text-pink-400';
      case IntermediateStepCategory.CUSTOM:
        return 'text-gray-500 dark:text-gray-400';
      case IntermediateStepCategory.SPAN:
        return 'text-teal-500 dark:text-teal-400';
      default:
        return 'text-gray-500 dark:text-gray-400';
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const toggleNode = (uuid: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(uuid)) {
        newSet.delete(uuid);
      } else {
        newSet.add(uuid);
      }
      return newSet;
    });
  };

  const renderStepNode = (node: StepNode, depth: number = 0): React.ReactNode => {
    const { step } = node;
    const category = getEventCategory(step.payload.event_type);
    const state = getEventState(step.payload.event_type);
    const isExpanded = expandedNodes.has(step.payload.UUID);
    const hasChildren = node.children.length > 0;
    const isActive = isStreaming && state === IntermediateStepState.START && !node.duration;

    // Filter out if category not selected
    if (filter.length && !filter.includes(category)) {
      return null;
    }

    return (
      <div key={step.payload.UUID} className="mb-1">
        <div
          className={`
            group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer
            transition-all duration-200 border-l-2 backdrop-blur-sm
            ${selectedStep?.payload.UUID === step.payload.UUID
              ? 'bg-white/20 border-nvidia-green shadow-[0_0_8px_rgba(118,185,0,0.2)]'
              : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20'}
          `}
          style={{ marginLeft: `${depth * 20}px` }}
          onClick={() => setSelectedStep(step)}
        >
          {hasChildren && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                toggleNode(step.payload.UUID);
              }}
              className="p-0.5 hover:bg-white/20 rounded transition-all"
            >
              {isExpanded ? <IconChevronDown size={14} className="text-white/60" /> : <IconChevronRight size={14} className="text-white/60" />}
            </button>
          )}
          {!hasChildren && <div className="w-5" />}

          <span className={`relative flex h-5 w-5 items-center justify-center text-base ${getCategoryColor(category)}`}>
            {isActive ? (
              <span className="relative flex h-5 w-5 items-center justify-center">
                <span className="absolute inline-flex h-full w-full rounded-full opacity-40 blur-sm bg-current animate-pulse" aria-hidden />
                <span className="absolute mx-auto h-full w-full rounded-full border border-current/40 animate-spin" aria-hidden />
                <span className="relative inline-flex items-center justify-center">
                  {getCategoryIcon(category)}
                </span>
              </span>
            ) : (
              getCategoryIcon(category)
            )}
          </span>

          <span className="text-sm font-medium text-white/90">
            {step.payload.name || step.payload.event_type}
          </span>

          <span className="text-xs text-white/40">
            {state}
          </span>

          {node.duration && (
            <span className="text-xs text-white/40 ml-auto">
              {formatDuration(node.duration)}
            </span>
          )}
        </div>

        {isExpanded && hasChildren && (
          <div className="mt-1">
            {node.children.map(childNode => renderStepNode(childNode, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderCategoryView = () => {
    if (!stepsByCategory.size) {
      if (showSkeleton) {
        return (
          <div className="space-y-2">
            {[...Array(4)].map((_, index) => (
              <div
                key={index}
                className="h-20 rounded-lg bg-white/5 backdrop-blur-sm animate-pulse"
              />
            ))}
          </div>
        );
      }

      if (showEmptyState) {
        return (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/20 p-6 text-sm text-white/40">
            No intermediate steps recorded yet.
          </div>
        );
      }
    }

    return (
      <div className="space-y-4">
        {Array.from(stepsByCategory.entries()).map(([category, categorySteps]) => (
          <div
            key={category}
            className="apple-glass-subtle rounded-xl p-4 transition-all hover:bg-white/10 hover:shadow-[0_0_20px_rgba(118,185,0,0.1)]"
          >
            <div className="flex items-center gap-2 mb-3">
              <span
                className={`inline-flex items-center gap-2 rounded-full bg-gradient-to-r px-3 py-1 text-xs font-semibold text-white shadow-sm ${
                  {
                    [IntermediateStepCategory.LLM]: 'from-sky-500 to-blue-500',
                    [IntermediateStepCategory.TOOL]: 'from-emerald-500 to-green-500',
                    [IntermediateStepCategory.WORKFLOW]: 'from-violet-500 to-purple-500',
                    [IntermediateStepCategory.TASK]: 'from-orange-500 to-amber-500',
                    [IntermediateStepCategory.FUNCTION]: 'from-pink-500 to-rose-500',
                    [IntermediateStepCategory.CUSTOM]: 'from-slate-500 to-slate-600',
                    [IntermediateStepCategory.SPAN]: 'from-teal-500 to-cyan-500',
                  }[category]
                }`}
              >
                {getCategoryIcon(category)}
                <span>{category}</span>
                <span className="ml-1 inline-flex items-center rounded-full bg-white/20 px-1.5 text-[10px] font-semibold">
                  {categorySteps.length}
                </span>
              </span>
              <button
                type="button"
                className="ml-auto text-xs text-white/40 hover:text-nvidia-green transition-colors"
                onClick={(event) => {
                  event.stopPropagation();
                  if (filter.includes(category)) {
                    onFilterChange(filter.filter((cat) => cat !== category));
                  } else {
                    onFilterChange([...filter, category]);
                  }
                }}
              >
                {filter.includes(category) ? 'Remove filter' : 'Focus'}
              </button>
            </div>
            <div className="space-y-1">
              {categorySteps.map((step) => (
                <div
                  key={step.payload.UUID}
                  className={`
                    group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer
                    transition-all backdrop-blur-sm
                    ${selectedStep?.payload.UUID === step.payload.UUID
                      ? 'bg-white/15 ring-1 ring-nvidia-green/40'
                      : 'bg-white/5 hover:bg-white/10'}
                  `}
                  onClick={() => setSelectedStep(step)}
                >
                  <span className="text-sm font-medium text-white/90">
                    {step.payload.name || step.payload.event_type}
                  </span>
                  <span className="text-xs text-white/40">
                    {getEventState(step.payload.event_type)}
                  </span>
                  <span className="ml-auto text-[11px] text-white/30 group-hover:text-white/50">
                    {new Date(step.payload.event_timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 min-h-0 p-4">
        {view === 'timeline' ? (
          <div className="space-y-1">
            {stepHierarchy.length ? (
              stepHierarchy.map((node) => renderStepNode(node))
            ) : showSkeleton ? (
              <div className="space-y-2">
                {[...Array(4)].map((_, index) => (
                  <div
                    key={index}
                    className="h-10 rounded-lg bg-white/5 backdrop-blur-sm animate-pulse"
                  />
                ))}
              </div>
            ) : showEmptyState ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/20 p-6 text-sm text-white/40">
                No intermediate steps recorded yet.
              </div>
            ) : null}
          </div>
        ) : (
          renderCategoryView()
        )}
      </div>

      {selectedStep && (
        <div className="w-full md:w-96 lg:w-[28rem] xl:w-[32rem] 2xl:w-[36rem] max-w-[40rem] border-l border-white/10 overflow-y-auto apple-glass-subtle">
          <StepDetails
            step={selectedStep}
            onClose={() => setSelectedStep(null)}
          />
        </div>
      )}
    </div>
  );
};
