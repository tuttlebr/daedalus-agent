// TypeScript definitions matching backend NAT intermediate steps structure

export enum IntermediateStepType {
  LLM_START = "LLM_START",
  LLM_END = "LLM_END",
  LLM_NEW_TOKEN = "LLM_NEW_TOKEN",
  TOOL_START = "TOOL_START",
  TOOL_END = "TOOL_END",
  WORKFLOW_START = "WORKFLOW_START",
  WORKFLOW_END = "WORKFLOW_END",
  TASK_START = "TASK_START",
  TASK_END = "TASK_END",
  FUNCTION_START = "FUNCTION_START",
  FUNCTION_END = "FUNCTION_END",
  CUSTOM_START = "CUSTOM_START",
  CUSTOM_END = "CUSTOM_END",
  SPAN_START = "SPAN_START",
  SPAN_CHUNK = "SPAN_CHUNK",
  SPAN_END = "SPAN_END"
}

export enum IntermediateStepCategory {
  LLM = "LLM",
  TOOL = "TOOL",
  WORKFLOW = "WORKFLOW",
  TASK = "TASK",
  FUNCTION = "FUNCTION",
  CUSTOM = "CUSTOM",
  SPAN = "SPAN"
}

export enum IntermediateStepState {
  START = "START",
  CHUNK = "CHUNK",
  END = "END"
}

export enum LLMFrameworkEnum {
  LANGCHAIN = "LANGCHAIN",
  LLAMA_INDEX = "LLAMA_INDEX",
  CUSTOM = "CUSTOM"
}

export interface StreamEventData {
  input?: any;
  output?: any;
  chunk?: any;
  result?: any;
  content?: any;
  response?: { content?: string; text?: string; [key: string]: any };
  [key: string]: any;
}

export interface TokenUsageBaseModel {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface UsageInfo {
  token_usage: TokenUsageBaseModel;
  num_llm_calls: number;
  seconds_between_calls: number;
}

export interface ToolParameters {
  properties: Record<string, any>;
  required: string[];
  type: "object";
  additionalProperties?: boolean;
  strict?: boolean;
}

export interface ToolDetails {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolSchema {
  type: "function";
  function: ToolDetails;
}

export interface TraceMetadata {
  chat_responses?: any;
  chat_inputs?: any;
  tool_inputs?: any;
  tool_outputs?: any;
  tool_info?: any;
  span_inputs?: any;
  span_outputs?: any;
  provided_metadata?: any;
  tools_schema?: ToolSchema[];
  [key: string]: any; // Allow extra fields
}

export interface IntermediateStepPayload {
  event_type: IntermediateStepType;
  event_timestamp: number;
  span_event_timestamp?: number;
  framework?: LLMFrameworkEnum;
  name?: string;
  tags?: string[];
  metadata?: Record<string, any> | TraceMetadata;
  data?: StreamEventData;
  usage_info?: UsageInfo;
  UUID: string;
  [key: string]: any; // Allow extra fields
}

export interface InvocationNode {
  node_id: string;
  parent_id: string | null;
  function_name: string;
  arguments?: Record<string, any>;
  depth: number;
}

export interface IntermediateStep {
  parent_id: string;
  function_ancestry: InvocationNode;
  payload: IntermediateStepPayload;
}

// Helper functions to get event category and state
export function getEventCategory(eventType: IntermediateStepType): IntermediateStepCategory {
  switch (eventType) {
    case IntermediateStepType.LLM_START:
    case IntermediateStepType.LLM_END:
    case IntermediateStepType.LLM_NEW_TOKEN:
      return IntermediateStepCategory.LLM;
    case IntermediateStepType.TOOL_START:
    case IntermediateStepType.TOOL_END:
      return IntermediateStepCategory.TOOL;
    case IntermediateStepType.WORKFLOW_START:
    case IntermediateStepType.WORKFLOW_END:
      return IntermediateStepCategory.WORKFLOW;
    case IntermediateStepType.TASK_START:
    case IntermediateStepType.TASK_END:
      return IntermediateStepCategory.TASK;
    case IntermediateStepType.FUNCTION_START:
    case IntermediateStepType.FUNCTION_END:
      return IntermediateStepCategory.FUNCTION;
    case IntermediateStepType.CUSTOM_START:
    case IntermediateStepType.CUSTOM_END:
      return IntermediateStepCategory.CUSTOM;
    case IntermediateStepType.SPAN_START:
    case IntermediateStepType.SPAN_CHUNK:
    case IntermediateStepType.SPAN_END:
      return IntermediateStepCategory.SPAN;
    default:
      throw new Error(`Unknown event type: ${eventType}`);
  }
}

export function getEventState(eventType: IntermediateStepType): IntermediateStepState {
  switch (eventType) {
    case IntermediateStepType.LLM_START:
    case IntermediateStepType.TOOL_START:
    case IntermediateStepType.WORKFLOW_START:
    case IntermediateStepType.TASK_START:
    case IntermediateStepType.FUNCTION_START:
    case IntermediateStepType.CUSTOM_START:
    case IntermediateStepType.SPAN_START:
      return IntermediateStepState.START;
    case IntermediateStepType.LLM_NEW_TOKEN:
    case IntermediateStepType.SPAN_CHUNK:
      return IntermediateStepState.CHUNK;
    case IntermediateStepType.LLM_END:
    case IntermediateStepType.TOOL_END:
    case IntermediateStepType.WORKFLOW_END:
    case IntermediateStepType.TASK_END:
    case IntermediateStepType.FUNCTION_END:
    case IntermediateStepType.CUSTOM_END:
    case IntermediateStepType.SPAN_END:
      return IntermediateStepState.END;
    default:
      throw new Error(`Unknown event type: ${eventType}`);
  }
}
