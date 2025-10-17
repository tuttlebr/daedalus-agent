import React from 'react';
import { IconX } from '@tabler/icons-react';
import {
  IntermediateStep,
  getEventCategory,
  getEventState,
  TraceMetadata
} from '@/types/intermediateSteps';

interface StepDetailsProps {
  step: IntermediateStep;
  onClose: () => void;
}

export const StepDetails: React.FC<StepDetailsProps> = ({ step, onClose }) => {
  const category = getEventCategory(step.payload.event_type);
  const state = getEventState(step.payload.event_type);

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  };

  const renderJSON = (data: any, title: string) => {
    if (!data) return null;

    return (
      <div className="mb-4">
        <h4 className="text-sm font-semibold mb-2 text-white/70">{title}</h4>
        <pre className="bg-black/20 backdrop-blur p-3 rounded-lg text-xs overflow-x-auto border border-white/10 text-white/80 font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    );
  };

  const renderMetadata = (metadata: Record<string, any> | TraceMetadata) => {
    if (!metadata) return null;

    // Check if it's TraceMetadata with specific fields
    const traceMetadata = metadata as TraceMetadata;

    return (
      <div className="space-y-3">
        {traceMetadata.chat_inputs && renderJSON(traceMetadata.chat_inputs, 'Chat Inputs')}
        {traceMetadata.chat_responses && renderJSON(traceMetadata.chat_responses, 'Chat Responses')}
        {traceMetadata.tool_inputs && renderJSON(traceMetadata.tool_inputs, 'Tool Inputs')}
        {traceMetadata.tool_outputs && renderJSON(traceMetadata.tool_outputs, 'Tool Outputs')}
        {traceMetadata.tools_schema && renderJSON(traceMetadata.tools_schema, 'Tools Schema')}
        {traceMetadata.span_inputs && renderJSON(traceMetadata.span_inputs, 'Span Inputs')}
        {traceMetadata.span_outputs && renderJSON(traceMetadata.span_outputs, 'Span Outputs')}

        {/* Render any other metadata fields */}
        {Object.entries(metadata).filter(([key]) =>
          !['chat_inputs', 'chat_responses', 'tool_inputs', 'tool_outputs',
           'tools_schema', 'span_inputs', 'span_outputs'].includes(key)
        ).map(([key, value]) => (
          value && renderJSON(value, key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '))
        ))}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-white/10 backdrop-blur-sm">
        <h3 className="text-lg font-semibold tracking-tight text-white/90">Step Details</h3>
        <button
          onClick={onClose}
          className="p-1 hover:bg-white/10 rounded transition-all text-white/60 hover:text-white"
        >
          <IconX size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Basic Information */}
        <div className="apple-glass-subtle rounded-xl p-4">
          <h4 className="text-sm font-semibold mb-3 uppercase tracking-[0.15em] text-white/40">Basic Information</h4>
          <div className="space-y-2 text-sm text-white/80">
            <div className="flex justify-between gap-4">
              <span className="text-white/40">Name</span>
              <span className="font-medium text-right text-white/90">{step.payload.name || 'N/A'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-white/40">Event Type</span>
              <span className="font-medium text-right text-white/90">{step.payload.event_type}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-white/40">Category</span>
              <span className="font-medium text-right text-white/90">{category}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-white/40">State</span>
              <span className="font-medium text-right text-white/90">{state}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-white/40">Timestamp</span>
              <span className="font-medium text-right text-white/90">{formatTimestamp(step.payload.event_timestamp)}</span>
            </div>
            {step.payload.framework && (
              <div className="flex justify-between gap-4">
                <span className="text-white/40">Framework</span>
                <span className="font-medium text-right text-white/90">{step.payload.framework}</span>
              </div>
            )}
          </div>
        </div>

        {/* Function Ancestry */}
        <div className="apple-glass-subtle rounded-xl p-4">
          <h4 className="text-sm font-semibold mb-3 uppercase tracking-[0.15em] text-white/40">Function Ancestry</h4>
          <div className="space-y-2 text-sm text-white/80">
            <div className="flex items-center justify-between">
              <span className="text-white/40">Function</span>
              <span className="font-medium text-white/90">{step.function_ancestry.function_name}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-white/40">
              <span>Node ID</span>
              <span className="text-white/60">{step.function_ancestry.node_id}</span>
            </div>
            {step.function_ancestry.parent_id && (
              <div className="flex items-center justify-between text-xs text-white/40">
                <span>Parent ID</span>
                <span className="text-white/60">{step.function_ancestry.parent_id}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-white/40">
              <span>Depth</span>
              <span className="text-white/60">{step.function_ancestry.depth}</span>
            </div>
          </div>
        </div>

        {/* Tags */}
        {step.payload.tags && step.payload.tags.length > 0 && (
          <div className="apple-glass-subtle rounded-xl p-4">
            <h4 className="text-sm font-semibold mb-3 uppercase tracking-[0.15em] text-white/40">Tags</h4>
            <div className="flex flex-wrap gap-1.5">
              {step.payload.tags.map((tag, index) => (
                <span
                  key={index}
                  className="px-2.5 py-1 text-xs bg-white/10 backdrop-blur-sm rounded-full text-white/80 border border-white/10"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Usage Info */}
        {step.payload.usage_info && (
          <div className="apple-glass-subtle rounded-xl p-4">
            <h4 className="text-sm font-semibold mb-3 uppercase tracking-[0.15em] text-white/40">Usage Information</h4>
            <div className="space-y-2 text-sm text-white/80">
              {step.payload.usage_info.token_usage && (
                <>
                  {step.payload.usage_info.token_usage.prompt_tokens && (
                    <div className="flex justify-between">
                      <span className="text-white/40">Prompt Tokens</span>
                      <span className="font-medium text-white/90">{step.payload.usage_info.token_usage.prompt_tokens}</span>
                    </div>
                  )}
                  {step.payload.usage_info.token_usage.completion_tokens && (
                    <div className="flex justify-between">
                      <span className="text-white/40">Completion Tokens</span>
                      <span className="font-medium text-white/90">{step.payload.usage_info.token_usage.completion_tokens}</span>
                    </div>
                  )}
                  {step.payload.usage_info.token_usage.total_tokens && (
                    <div className="flex justify-between">
                      <span className="text-white/40">Total Tokens</span>
                      <span className="font-medium text-white/90">{step.payload.usage_info.token_usage.total_tokens}</span>
                    </div>
                  )}
                </>
              )}
              <div className="flex justify-between">
                <span className="text-white/40">LLM Calls</span>
                <span className="font-medium text-white/90">{step.payload.usage_info.num_llm_calls}</span>
              </div>
            </div>
          </div>
        )}

        {/* Event Data */}
        {step.payload.data && (
          <div className="apple-glass-subtle rounded-xl p-4">
            <h4 className="text-sm font-semibold mb-3 uppercase tracking-[0.15em] text-white/40">Event Data</h4>
            {step.payload.data.input && renderJSON(step.payload.data.input, 'Input')}
            {step.payload.data.output && renderJSON(step.payload.data.output, 'Output')}
            {step.payload.data.chunk && renderJSON(step.payload.data.chunk, 'Chunk')}
          </div>
        )}

        {/* Metadata */}
        {step.payload.metadata && (
          <div className="apple-glass-subtle rounded-xl p-4">
            <h4 className="text-sm font-semibold mb-3 uppercase tracking-[0.15em] text-white/40">Metadata</h4>
            {renderMetadata(step.payload.metadata)}
          </div>
        )}
      </div>
    </div>
  );
};
