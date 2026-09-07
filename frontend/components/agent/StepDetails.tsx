import { IconX, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import React, { useState, useId } from 'react';

import {
  ConsolidatedStep,
  formatDuration,
} from '@/utils/app/intermediateSteps';
import {
  normalizeLatexDelimiters,
  containsLatex,
} from '@/utils/app/latexNormalizer';

import {
  getEventState,
  IntermediateStepCategory,
  TraceMetadata,
} from '@/types/intermediateSteps';

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

interface StepDetailsProps {
  consolidatedStep: ConsolidatedStep;
  onClose: () => void;
}

export const StepDetails: React.FC<StepDetailsProps> = ({
  consolidatedStep,
  onClose,
}) => {
  const advancedId = useId();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const step = consolidatedStep.endStep || consolidatedStep.startStep;
  const category = consolidatedStep.category;

  const renderContent = (data: any, title: string) => {
    if (!data) return null;

    if (typeof data === 'string') {
      const normalizedContent = normalizeLatexDelimiters(data);
      const hasLatex = containsLatex(normalizedContent);
      const hasMarkdown = /[#*`\[\]_~]/.test(data) || hasLatex;

      if (hasMarkdown || hasLatex) {
        return (
          <div className="mb-3">
            <h4 className="text-xs font-semibold mb-1.5 text-muted uppercase tracking-wider">
              {title}
            </h4>
            <div
              tabIndex={0}
              aria-label={title}
              className="bg-fill/5 p-3 rounded-lg overflow-x-auto border border-separator/70"
            >
              <MarkdownRenderer
                content={normalizedContent}
                className="prose prose-sm dark:prose-invert max-w-none"
                enableMath={true}
              />
            </div>
          </div>
        );
      }

      return (
        <div className="mb-3">
          <h4 className="text-xs font-semibold mb-1.5 text-muted uppercase tracking-wider">
            {title}
          </h4>
          <div className="bg-fill/5 p-3 rounded-lg text-sm border border-separator/70 text-secondary whitespace-pre-wrap break-words">
            {data}
          </div>
        </div>
      );
    }

    return (
      <div className="mb-3">
        <h4 className="text-xs font-semibold mb-1.5 text-muted uppercase tracking-wider">
          {title}
        </h4>
        <pre
          tabIndex={0}
          aria-label={title}
          className="bg-fill/5 p-3 rounded-lg text-xs overflow-x-auto border border-separator/70 text-secondary font-mono"
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    );
  };

  const getCategoryLabel = (cat: IntermediateStepCategory): string => {
    switch (cat) {
      case IntermediateStepCategory.LLM:
        return 'Language Model';
      case IntermediateStepCategory.TOOL:
        return 'Tool';
      case IntermediateStepCategory.WORKFLOW:
        return 'Workflow';
      case IntermediateStepCategory.TASK:
        return 'Task';
      case IntermediateStepCategory.FUNCTION:
        return 'Function';
      default:
        return 'Process';
    }
  };

  // Extract the meaningful input/output for display
  const meta = step.payload.metadata as TraceMetadata | undefined;
  const toolInputs = meta?.tool_inputs;
  const toolOutputs = meta?.tool_outputs;
  const chatResponses = meta?.chat_responses;
  const spanOutputs = meta?.span_outputs;
  const dataInput = step.payload.data?.input;
  const dataOutput = step.payload.data?.output || step.payload.data?.result;

  const hasUserContent = !!(
    toolInputs ||
    toolOutputs ||
    chatResponses ||
    spanOutputs ||
    dataInput ||
    dataOutput
  );

  return (
    <div className="min-w-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-separator/70">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-primary break-words">
            {consolidatedStep.friendlyName}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted">
              {getCategoryLabel(category)}
            </span>
            {consolidatedStep.duration && (
              <>
                <span className="text-muted">·</span>
                <span className="text-xs text-muted">
                  {formatDuration(consolidatedStep.duration)}
                </span>
              </>
            )}
            {consolidatedStep.status === 'active' && (
              <span className="text-xs text-nvidia-green font-medium">
                In progress
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close activity details"
          onClick={onClose}
          className="p-1.5 hover:bg-fill/10 rounded-lg transition-all text-muted hover:text-primary flex-shrink-0"
        >
          <IconX size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Context summary */}
        {consolidatedStep.context && (
          <div className="bg-nvidia-green/[0.06] border border-nvidia-green/10 rounded-lg p-3">
            <p className="text-sm text-secondary">{consolidatedStep.context}</p>
          </div>
        )}

        {/* User-relevant content: what went in, what came out */}
        {hasUserContent && (
          <div className="space-y-1">
            {toolInputs && renderContent(toolInputs, 'What was requested')}
            {!toolInputs && dataInput && renderContent(dataInput, 'Input')}
            {toolOutputs && renderContent(toolOutputs, 'Result')}
            {!toolOutputs &&
              chatResponses &&
              renderContent(chatResponses, 'Response')}
            {!toolOutputs &&
              !chatResponses &&
              spanOutputs &&
              renderContent(spanOutputs, 'Output')}
            {!toolOutputs &&
              !chatResponses &&
              !spanOutputs &&
              dataOutput &&
              renderContent(dataOutput, 'Result')}
          </div>
        )}

        {/* Token usage — shown by default since it's useful */}
        {step.payload.usage_info && (
          <div className="rounded-lg bg-fill/[0.04] p-3">
            <div className="flex items-center gap-4 text-xs text-muted">
              {step.payload.usage_info.token_usage?.total_tokens && (
                <span>
                  {step.payload.usage_info.token_usage.total_tokens.toLocaleString()}{' '}
                  tokens
                </span>
              )}
              {step.payload.usage_info.num_llm_calls > 0 && (
                <span>
                  {step.payload.usage_info.num_llm_calls} LLM call
                  {step.payload.usage_info.num_llm_calls > 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Advanced Details — collapsed by default */}
        <div className="border-t border-separator/70 pt-3 mt-4">
          <button
            type="button"
            aria-expanded={showAdvanced}
            aria-controls={advancedId}
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-muted transition-colors"
          >
            {showAdvanced ? (
              <IconChevronDown size={14} />
            ) : (
              <IconChevronRight size={14} />
            )}
            Advanced Details
          </button>

          {showAdvanced && (
            <div id={advancedId} className="mt-3 space-y-3 animate-slide-in">
              {/* Raw event info */}
              <div className="rounded-lg bg-fill/[0.04] p-3 space-y-2 text-xs text-secondary">
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">Event Type</span>
                  <span className="min-w-0 break-all font-mono">
                    {step.payload.event_type}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">State</span>
                  <span className="min-w-0 break-all font-mono">
                    {getEventState(step.payload.event_type)}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">Raw Name</span>
                  <span className="min-w-0 break-all font-mono">
                    {step.payload.name || 'N/A'}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">Timestamp</span>
                  <span className="min-w-0 break-all font-mono">
                    {new Date(
                      step.payload.event_timestamp * 1000,
                    ).toLocaleTimeString('en-US', {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      fractionalSecondDigits: 3,
                    })}
                  </span>
                </div>
                {step.payload.framework && (
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span className="text-muted">Framework</span>
                    <span className="min-w-0 break-all font-mono">
                      {step.payload.framework}
                    </span>
                  </div>
                )}
              </div>

              {/* Function ancestry */}
              <div className="rounded-lg bg-fill/[0.04] p-3 space-y-2 text-xs text-secondary">
                <div className="text-muted font-semibold uppercase tracking-wider mb-1">
                  Function Ancestry
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">Function</span>
                  <span className="min-w-0 break-all font-mono">
                    {step.function_ancestry.function_name}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">Node ID</span>
                  <span className="font-mono text-muted break-all">
                    {step.function_ancestry.node_id}
                  </span>
                </div>
                {step.function_ancestry.parent_id && (
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span className="text-muted">Parent ID</span>
                    <span className="font-mono text-muted break-all">
                      {step.function_ancestry.parent_id}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <span className="text-muted">Depth</span>
                  <span className="min-w-0 break-all font-mono">
                    {step.function_ancestry.depth}
                  </span>
                </div>
              </div>

              {/* Tags */}
              {step.payload.tags && step.payload.tags.length > 0 && (
                <div className="rounded-lg bg-fill/[0.04] p-3">
                  <div className="text-muted text-xs font-semibold uppercase tracking-wider mb-2">
                    Tags
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {step.payload.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 text-xs bg-fill/10 rounded-full text-secondary font-mono"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* UUID */}
              <div className="rounded-lg bg-fill/[0.04] p-3 text-xs">
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-muted">
                  <span className="text-muted">UUID</span>
                  <span className="font-mono break-all">
                    {step.payload.UUID}
                  </span>
                </div>
              </div>

              {/* Full metadata dump */}
              {step.payload.metadata && (
                <div className="rounded-lg bg-fill/[0.04] p-3">
                  <div className="text-muted text-xs font-semibold uppercase tracking-wider mb-2">
                    Raw Metadata
                  </div>
                  <pre
                    tabIndex={0}
                    aria-label="Raw metadata"
                    className="text-xs text-muted font-mono overflow-x-auto whitespace-pre-wrap break-words"
                  >
                    {JSON.stringify(step.payload.metadata, null, 2)}
                  </pre>
                </div>
              )}

              {/* Full event data dump */}
              {step.payload.data && (
                <div className="rounded-lg bg-fill/[0.04] p-3">
                  <div className="text-muted text-xs font-semibold uppercase tracking-wider mb-2">
                    Raw Event Data
                  </div>
                  <pre
                    tabIndex={0}
                    aria-label="Raw event data"
                    className="text-xs text-muted font-mono overflow-x-auto whitespace-pre-wrap break-words"
                  >
                    {JSON.stringify(step.payload.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
