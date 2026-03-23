import React, { useState } from 'react';
import { IconX, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import {
  IntermediateStep,
  getEventCategory,
  getEventState,
  IntermediateStepCategory,
  TraceMetadata,
} from '@/types/intermediateSteps';
import { ConsolidatedStep, formatDuration, getFriendlyName } from '@/utils/app/intermediateSteps';
import { MarkdownRenderer } from '@/components/Markdown/MarkdownRenderer';
import { normalizeLatexDelimiters, containsLatex } from '@/utils/app/latexNormalizer';

interface StepDetailsProps {
  consolidatedStep: ConsolidatedStep;
  onClose: () => void;
}

export const StepDetails: React.FC<StepDetailsProps> = ({ consolidatedStep, onClose }) => {
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
            <h4 className="text-xs font-semibold mb-1.5 text-white/50 uppercase tracking-wider">{title}</h4>
            <div className="bg-black/20 backdrop-blur p-3 rounded-lg overflow-x-auto border border-white/10">
              <MarkdownRenderer
                content={normalizedContent}
                className="prose prose-sm dark:prose-invert max-w-none [&_*]:!text-white/90"
                enableMath={true}
              />
            </div>
          </div>
        );
      }

      return (
        <div className="mb-3">
          <h4 className="text-xs font-semibold mb-1.5 text-white/50 uppercase tracking-wider">{title}</h4>
          <div className="bg-black/20 backdrop-blur p-3 rounded-lg text-xs overflow-x-auto border border-white/10 text-white/80 whitespace-pre-wrap">
            {data}
          </div>
        </div>
      );
    }

    return (
      <div className="mb-3">
        <h4 className="text-xs font-semibold mb-1.5 text-white/50 uppercase tracking-wider">{title}</h4>
        <pre className="bg-black/20 backdrop-blur p-3 rounded-lg text-xs overflow-x-auto border border-white/10 text-white/80 font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    );
  };

  const getCategoryLabel = (cat: IntermediateStepCategory): string => {
    switch (cat) {
      case IntermediateStepCategory.LLM: return 'Language Model';
      case IntermediateStepCategory.TOOL: return 'Tool';
      case IntermediateStepCategory.WORKFLOW: return 'Workflow';
      case IntermediateStepCategory.TASK: return 'Task';
      case IntermediateStepCategory.FUNCTION: return 'Function';
      default: return 'Process';
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

  const hasUserContent = !!(toolInputs || toolOutputs || chatResponses || spanOutputs || dataInput || dataOutput);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-white/90 truncate">
            {consolidatedStep.friendlyName}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-white/40">{getCategoryLabel(category)}</span>
            {consolidatedStep.duration && (
              <>
                <span className="text-white/20">·</span>
                <span className="text-xs text-white/40">{formatDuration(consolidatedStep.duration)}</span>
              </>
            )}
            {consolidatedStep.status === 'active' && (
              <span className="text-xs text-nvidia-green font-medium">In progress</span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-white/50 hover:text-white flex-shrink-0"
        >
          <IconX size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Context summary */}
        {consolidatedStep.context && (
          <div className="bg-nvidia-green/[0.06] border border-nvidia-green/10 rounded-lg p-3">
            <p className="text-sm text-white/80">{consolidatedStep.context}</p>
          </div>
        )}

        {/* User-relevant content: what went in, what came out */}
        {hasUserContent && (
          <div className="space-y-1">
            {toolInputs && renderContent(toolInputs, 'What was requested')}
            {!toolInputs && dataInput && renderContent(dataInput, 'Input')}
            {toolOutputs && renderContent(toolOutputs, 'Result')}
            {!toolOutputs && chatResponses && renderContent(chatResponses, 'Response')}
            {!toolOutputs && !chatResponses && spanOutputs && renderContent(spanOutputs, 'Output')}
            {!toolOutputs && !chatResponses && !spanOutputs && dataOutput && renderContent(dataOutput, 'Result')}
          </div>
        )}

        {/* Token usage — shown by default since it's useful */}
        {step.payload.usage_info && (
          <div className="rounded-lg bg-white/[0.04] p-3">
            <div className="flex items-center gap-4 text-xs text-white/50">
              {step.payload.usage_info.token_usage?.total_tokens && (
                <span>{step.payload.usage_info.token_usage.total_tokens.toLocaleString()} tokens</span>
              )}
              {step.payload.usage_info.num_llm_calls > 0 && (
                <span>{step.payload.usage_info.num_llm_calls} LLM call{step.payload.usage_info.num_llm_calls > 1 ? 's' : ''}</span>
              )}
            </div>
          </div>
        )}

        {/* Advanced Details — collapsed by default */}
        <div className="border-t border-white/[0.06] pt-3 mt-4">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/50 transition-colors"
          >
            {showAdvanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            Advanced Details
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3 animate-slide-in">
              {/* Raw event info */}
              <div className="rounded-lg bg-white/[0.04] p-3 space-y-2 text-xs text-white/60">
                <div className="flex justify-between">
                  <span className="text-white/30">Event Type</span>
                  <span className="font-mono">{step.payload.event_type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/30">State</span>
                  <span className="font-mono">{getEventState(step.payload.event_type)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/30">Raw Name</span>
                  <span className="font-mono">{step.payload.name || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/30">Timestamp</span>
                  <span className="font-mono">
                    {new Date(step.payload.event_timestamp * 1000).toLocaleTimeString('en-US', {
                      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
                      fractionalSecondDigits: 3
                    })}
                  </span>
                </div>
                {step.payload.framework && (
                  <div className="flex justify-between">
                    <span className="text-white/30">Framework</span>
                    <span className="font-mono">{step.payload.framework}</span>
                  </div>
                )}
              </div>

              {/* Function ancestry */}
              <div className="rounded-lg bg-white/[0.04] p-3 space-y-2 text-xs text-white/60">
                <div className="text-white/30 font-semibold uppercase tracking-wider mb-1">Function Ancestry</div>
                <div className="flex justify-between">
                  <span className="text-white/30">Function</span>
                  <span className="font-mono">{step.function_ancestry.function_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/30">Node ID</span>
                  <span className="font-mono text-white/40 truncate max-w-[200px]">{step.function_ancestry.node_id}</span>
                </div>
                {step.function_ancestry.parent_id && (
                  <div className="flex justify-between">
                    <span className="text-white/30">Parent ID</span>
                    <span className="font-mono text-white/40 truncate max-w-[200px]">{step.function_ancestry.parent_id}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-white/30">Depth</span>
                  <span className="font-mono">{step.function_ancestry.depth}</span>
                </div>
              </div>

              {/* Tags */}
              {step.payload.tags && step.payload.tags.length > 0 && (
                <div className="rounded-lg bg-white/[0.04] p-3">
                  <div className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-2">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {step.payload.tags.map((tag, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs bg-white/10 rounded-full text-white/60 font-mono">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* UUID */}
              <div className="rounded-lg bg-white/[0.04] p-3 text-xs">
                <div className="flex justify-between text-white/40">
                  <span className="text-white/30">UUID</span>
                  <span className="font-mono truncate max-w-[240px]">{step.payload.UUID}</span>
                </div>
              </div>

              {/* Full metadata dump */}
              {step.payload.metadata && (
                <div className="rounded-lg bg-white/[0.04] p-3">
                  <div className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-2">Raw Metadata</div>
                  <pre className="text-xs text-white/50 font-mono overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(step.payload.metadata, null, 2)}
                  </pre>
                </div>
              )}

              {/* Full event data dump */}
              {step.payload.data && (
                <div className="rounded-lg bg-white/[0.04] p-3">
                  <div className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-2">Raw Event Data</div>
                  <pre className="text-xs text-white/50 font-mono overflow-x-auto whitespace-pre-wrap">
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
