import {
  IntermediateStep,
  IntermediateStepCategory,
  IntermediateStepType,
  IntermediateStepState,
  getEventCategory,
  getEventState
} from '@/types/intermediateSteps';

interface StepNode {
  step: IntermediateStep;
  children: StepNode[];
  duration?: number;
  startTimestamp?: number;
  endTimestamp?: number;
}

interface CategoryGroup {
  category: IntermediateStepCategory;
  steps: IntermediateStep[];
  totalDuration: number;
  count: number;
}

/**
 * Group steps by their event category
 */
export function groupStepsByCategory(steps: IntermediateStep[]): Map<IntermediateStepCategory, IntermediateStep[]> {
  const grouped = new Map<IntermediateStepCategory, IntermediateStep[]>();

  steps.forEach(step => {
    const category = getEventCategory(step.payload.event_type);
    const categorySteps = grouped.get(category) || [];
    categorySteps.push(step);
    grouped.set(category, categorySteps);
  });

  return grouped;
}

/**
 * Build a hierarchical tree structure from flat steps array using parent_id relationships
 */
export function buildStepHierarchy(steps: IntermediateStep[]): StepNode[] {
  const nodeMap = new Map<string, StepNode>();
  const rootNodes: StepNode[] = [];
  const uuidToStartTime = new Map<string, number>();

  // First pass: create all nodes and track START event times
  steps.forEach(step => {
    const node: StepNode = { step, children: [] };
    nodeMap.set(step.payload.UUID, node);

    // Track START event timestamps for duration calculation
    if (getEventState(step.payload.event_type) === IntermediateStepState.START) {
      uuidToStartTime.set(step.payload.UUID, step.payload.event_timestamp);
    }
  });

  // Second pass: build hierarchy and calculate durations
  steps.forEach(step => {
    const node = nodeMap.get(step.payload.UUID);
    if (!node) return;

    // Calculate duration for END events
    if (getEventState(step.payload.event_type) === IntermediateStepState.END) {
      // First check if span_event_timestamp is provided (backend calculated)
      if (step.payload.span_event_timestamp) {
        node.duration = (step.payload.event_timestamp - step.payload.span_event_timestamp) * 1000; // Convert to ms
        node.startTimestamp = step.payload.span_event_timestamp;
        node.endTimestamp = step.payload.event_timestamp;
      } else {
        // Try to find matching START event by name and parent
        const matchingStartStep = steps.find(s =>
          s.parent_id === step.parent_id &&
          s.payload.name === step.payload.name &&
          getEventState(s.payload.event_type) === IntermediateStepState.START &&
          s.payload.event_timestamp < step.payload.event_timestamp
        );

        if (matchingStartStep) {
          node.duration = (step.payload.event_timestamp - matchingStartStep.payload.event_timestamp) * 1000;
          node.startTimestamp = matchingStartStep.payload.event_timestamp;
          node.endTimestamp = step.payload.event_timestamp;
        }
      }
    }

    // Add to parent or root
    if (step.parent_id === 'root' || !step.parent_id) {
      rootNodes.push(node);
    } else {
      // Try to find parent by UUID first
      let parentNode = nodeMap.get(step.parent_id);

      // If not found, try to find by matching parent in the steps
      if (!parentNode) {
        const parentStep = steps.find(s => s.payload.UUID === step.parent_id);
        if (parentStep) {
          parentNode = nodeMap.get(parentStep.payload.UUID);
        }
      }

      if (parentNode) {
        parentNode.children.push(node);
      } else {
        // Fallback to root if parent not found
        rootNodes.push(node);
      }
    }
  });

  // Sort children by timestamp
  const sortNodes = (nodes: StepNode[]) => {
    nodes.sort((a, b) => a.step.payload.event_timestamp - b.step.payload.event_timestamp);
    nodes.forEach(node => sortNodes(node.children));
  };

  sortNodes(rootNodes);

  return rootNodes;
}

/**
 * Calculate duration between matching START and END events
 */
export function calculateStepDuration(startStep: IntermediateStep, endStep: IntermediateStep): number | null {
  if (getEventState(startStep.payload.event_type) !== IntermediateStepState.START ||
      getEventState(endStep.payload.event_type) !== IntermediateStepState.END) {
    return null;
  }

  // Check if they're matching events (same name and parent)
  if (startStep.payload.name !== endStep.payload.name ||
      startStep.parent_id !== endStep.parent_id) {
    return null;
  }

  return (endStep.payload.event_timestamp - startStep.payload.event_timestamp) * 1000; // Return in ms
}

/**
 * Format step data for display, handling different data types
 */
export function formatStepData(data: any, maxLength: number = 1000): string {
  if (!data) return '';

  // Handle string data
  if (typeof data === 'string') {
    return data.length > maxLength ? data.substring(0, maxLength) + '...' : data;
  }

  // Handle object/array data
  try {
    const jsonString = JSON.stringify(data, null, 2);
    return jsonString.length > maxLength
      ? jsonString.substring(0, maxLength) + '...'
      : jsonString;
  } catch (error) {
    return String(data);
  }
}

/**
 * Search steps by text in name, type, or data
 */
export function searchSteps(steps: IntermediateStep[], searchTerm: string): IntermediateStep[] {
  if (!searchTerm || !searchTerm.trim()) return steps;

  const term = searchTerm.toLowerCase();

  return steps.filter(step => {
    // Search in name
    if (step.payload.name?.toLowerCase().includes(term)) return true;

    // Search in event type
    if (step.payload.event_type.toLowerCase().includes(term)) return true;

    // Search in tags
    if (step.payload.tags?.some(tag => tag.toLowerCase().includes(term))) return true;

    // Search in function name
    if (step.function_ancestry.function_name.toLowerCase().includes(term)) return true;

    // Search in data (limited to avoid performance issues)
    try {
      const dataString = JSON.stringify(step.payload.data).toLowerCase();
      if (dataString.includes(term)) return true;
    } catch (error) {
      // Ignore JSON stringify errors
    }

    return false;
  });
}

/**
 * Get summary statistics for steps
 */
export function getStepStatistics(steps: IntermediateStep[]): {
  totalSteps: number;
  byCategory: CategoryGroup[];
  totalDuration: number;
  avgDuration: number;
} {
  const categoryMap = groupStepsByCategory(steps);
  const byCategory: CategoryGroup[] = [];
  let totalDuration = 0;
  let durationCount = 0;

  categoryMap.forEach((categorySteps, category) => {
    let categoryDuration = 0;

    // Calculate durations for this category
    const endSteps = categorySteps.filter(s =>
      getEventState(s.payload.event_type) === IntermediateStepState.END
    );

    endSteps.forEach(endStep => {
      if (endStep.payload.span_event_timestamp) {
        const duration = (endStep.payload.event_timestamp - endStep.payload.span_event_timestamp) * 1000;
        categoryDuration += duration;
        totalDuration += duration;
        durationCount++;
      }
    });

    byCategory.push({
      category,
      steps: categorySteps,
      totalDuration: categoryDuration,
      count: categorySteps.length
    });
  });

  return {
    totalSteps: steps.length,
    byCategory,
    totalDuration,
    avgDuration: durationCount > 0 ? totalDuration / durationCount : 0
  };
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

// ─── User-Friendly Consolidated Steps ────────────────────────────────────────

export interface ConsolidatedStep {
  id: string;
  friendlyName: string;
  category: IntermediateStepCategory;
  status: 'active' | 'completed';
  duration?: number;
  context?: string;
  input?: any;
  output?: any;
  startStep: IntermediateStep;
  endStep?: IntermediateStep;
  children: ConsolidatedStep[];
  depth: number;
}

const FRIENDLY_NAMES: Record<string, string> = {
  webscrape: 'Searching the web',
  serpapi_search: 'Searching the web',
  smart_milvus: 'Searching knowledge base',
  image_generation: 'Generating image',
  image_comprehension: 'Analyzing image',
  image_augmentation: 'Editing image',
  rss_feed: 'Reading RSS feeds',
  nat_nv_ingest: 'Processing document',
  vtt_interpreter: 'Processing transcript',
  json_repair_agent: 'Repairing JSON output',
  agent_skills: 'Using agent skills',
  llm_diagnostics: 'Running diagnostics',
};

const CATEGORY_LABELS: Record<IntermediateStepCategory, string> = {
  [IntermediateStepCategory.LLM]: 'Thinking',
  [IntermediateStepCategory.TOOL]: 'Using tool',
  [IntermediateStepCategory.WORKFLOW]: 'Running workflow',
  [IntermediateStepCategory.TASK]: 'Processing',
  [IntermediateStepCategory.FUNCTION]: 'Running function',
  [IntermediateStepCategory.CUSTOM]: 'Processing',
  [IntermediateStepCategory.SPAN]: 'Processing',
};

function cleanupName(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

export function getFriendlyName(step: IntermediateStep): string {
  const category = getEventCategory(step.payload.event_type);
  const rawName = (step.payload.name || step.function_ancestry.function_name || '').toLowerCase();

  // Check exact match first
  for (const [key, label] of Object.entries(FRIENDLY_NAMES)) {
    if (rawName === key || rawName.includes(key)) return label;
  }

  // Category-based fallback
  if (category === IntermediateStepCategory.LLM) return 'Thinking';

  // Clean up the raw name if we have one
  if (step.payload.name) return cleanupName(step.payload.name);
  if (step.function_ancestry.function_name) return cleanupName(step.function_ancestry.function_name);

  return CATEGORY_LABELS[category] || 'Processing';
}

function extractContext(step: IntermediateStep): string | undefined {
  const category = getEventCategory(step.payload.event_type);

  // Don't show context for LLM steps (it's just the full prompt)
  if (category === IntermediateStepCategory.LLM) return undefined;

  // Try tool_inputs from metadata
  const meta = step.payload.metadata;
  if (meta) {
    const toolInputs = (meta as any).tool_inputs;
    if (toolInputs) {
      if (typeof toolInputs === 'string') return truncate(toolInputs, 120);
      // Try to extract a query/url/input field from tool inputs
      const queryField = toolInputs.query || toolInputs.url || toolInputs.input ||
                         toolInputs.question || toolInputs.search_query || toolInputs.prompt;
      if (queryField && typeof queryField === 'string') return truncate(queryField, 120);
      // If it's an object with few keys, show a brief summary
      const keys = Object.keys(toolInputs);
      if (keys.length <= 3) {
        const parts = keys.map(k => {
          const v = toolInputs[k];
          return `${k}: ${typeof v === 'string' ? truncate(v, 40) : JSON.stringify(v)}`;
        });
        return truncate(parts.join(', '), 120);
      }
    }
  }

  // Try data.input
  const dataInput = step.payload.data?.input;
  if (dataInput) {
    if (typeof dataInput === 'string') return truncate(dataInput, 120);
    const queryField = dataInput.query || dataInput.url || dataInput.input || dataInput.question;
    if (queryField && typeof queryField === 'string') return truncate(queryField, 120);
  }

  return undefined;
}

function extractOutput(step: IntermediateStep): any {
  const meta = step.payload.metadata;
  if (meta) {
    const toolOutputs = (meta as any).tool_outputs;
    if (toolOutputs) return toolOutputs;
    const chatResponses = (meta as any).chat_responses;
    if (chatResponses) return chatResponses;
    const spanOutputs = (meta as any).span_outputs;
    if (spanOutputs) return spanOutputs;
  }
  return step.payload.data?.output || step.payload.data?.result || step.payload.data?.response;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen).trimEnd() + '...';
}

/**
 * Consolidate START/END pairs into single user-friendly entries.
 * Active steps (START without matching END) show as in-progress.
 *
 * Pairing uses a queue per name+parent_id key so repeated operations
 * (e.g. multiple LLM calls) each get their own pair.
 * END events can also match via span_event_timestamp ≈ START timestamp.
 */
export function consolidateSteps(steps: IntermediateStep[], isComplete?: boolean): ConsolidatedStep[] {
  const sorted = [...steps].sort((a, b) => a.payload.event_timestamp - b.payload.event_timestamp);

  // Queue of unpaired STARTs per name+parent key
  const startQueues = new Map<string, IntermediateStep[]>();
  // Completed pairs
  const pairs: { start: IntermediateStep; end: IntermediateStep }[] = [];
  // Orphaned ENDs (no matching START found)
  const orphanedEnds: IntermediateStep[] = [];

  sorted.forEach(step => {
    const state = getEventState(step.payload.event_type);
    if (state === IntermediateStepState.CHUNK) return;

    const key = `${step.payload.name || step.function_ancestry.function_name}::${step.parent_id}`;

    if (state === IntermediateStepState.START) {
      const queue = startQueues.get(key) || [];
      queue.push(step);
      startQueues.set(key, queue);
    } else if (state === IntermediateStepState.END) {
      const queue = startQueues.get(key);

      if (queue && queue.length > 0) {
        // Pair with earliest unpaired START
        // If END has span_event_timestamp, prefer the START whose timestamp matches
        let matchIdx = 0;
        if (step.payload.span_event_timestamp && queue.length > 1) {
          const spanTs = step.payload.span_event_timestamp;
          const bestIdx = queue.findIndex(s =>
            Math.abs(s.payload.event_timestamp - spanTs) < 0.01
          );
          if (bestIdx >= 0) matchIdx = bestIdx;
        }
        const matchedStart = queue.splice(matchIdx, 1)[0];
        pairs.push({ start: matchedStart, end: step });
      } else {
        orphanedEnds.push(step);
      }
    }
  });

  // Build consolidated steps from pairs + remaining unpaired STARTs + orphaned ENDs
  const consolidated: ConsolidatedStep[] = [];

  // Paired steps (completed)
  pairs.forEach(({ start, end }) => {
    let duration: number | undefined;
    if (end.payload.span_event_timestamp) {
      duration = (end.payload.event_timestamp - end.payload.span_event_timestamp) * 1000;
    } else {
      duration = (end.payload.event_timestamp - start.payload.event_timestamp) * 1000;
    }

    consolidated.push({
      id: end.payload.UUID,
      friendlyName: getFriendlyName(end),
      category: getEventCategory(end.payload.event_type),
      status: 'completed',
      duration,
      context: extractContext(start) || extractContext(end),
      input: start.payload.data?.input || (start.payload.metadata as any)?.tool_inputs,
      output: extractOutput(end),
      startStep: start,
      endStep: end,
      children: [],
      depth: start.function_ancestry.depth || 0,
    });
  });

  // Unpaired STARTs: active while streaming, completed once the response is done
  startQueues.forEach(queue => {
    queue.forEach(start => {
      consolidated.push({
        id: start.payload.UUID,
        friendlyName: getFriendlyName(start),
        category: getEventCategory(start.payload.event_type),
        status: isComplete ? 'completed' : 'active',
        context: extractContext(start),
        input: start.payload.data?.input || (start.payload.metadata as any)?.tool_inputs,
        startStep: start,
        children: [],
        depth: start.function_ancestry.depth || 0,
      });
    });
  });

  // Orphaned ENDs (completed but no START found — use span_event_timestamp for duration)
  orphanedEnds.forEach(end => {
    let duration: number | undefined;
    if (end.payload.span_event_timestamp) {
      duration = (end.payload.event_timestamp - end.payload.span_event_timestamp) * 1000;
    }

    consolidated.push({
      id: end.payload.UUID,
      friendlyName: getFriendlyName(end),
      category: getEventCategory(end.payload.event_type),
      status: 'completed',
      duration,
      context: extractContext(end),
      output: extractOutput(end),
      startStep: end,
      endStep: end,
      children: [],
      depth: end.function_ancestry.depth || 0,
    });
  });

  // Sort by start time
  consolidated.sort((a, b) => a.startStep.payload.event_timestamp - b.startStep.payload.event_timestamp);

  // Build hierarchy from depth/parent relationships
  return buildConsolidatedHierarchy(consolidated);
}

function buildConsolidatedHierarchy(steps: ConsolidatedStep[]): ConsolidatedStep[] {
  if (steps.length === 0) return [];

  const rootSteps: ConsolidatedStep[] = [];
  const parentStack: ConsolidatedStep[] = [];

  steps.forEach(step => {
    // Find the right parent based on parent_id
    const parentId = step.startStep.parent_id;

    if (parentId === 'root' || !parentId) {
      rootSteps.push(step);
      parentStack.length = 0;
      parentStack.push(step);
    } else {
      // Look for a matching parent in existing consolidated steps
      const parent = findParent(rootSteps, parentId);
      if (parent) {
        parent.children.push(step);
      } else {
        rootSteps.push(step);
      }
    }
  });

  return rootSteps;
}

function findParent(steps: ConsolidatedStep[], parentId: string): ConsolidatedStep | null {
  for (const step of steps) {
    if (step.startStep.payload.UUID === parentId || step.endStep?.payload.UUID === parentId) {
      return step;
    }
    const found = findParent(step.children, parentId);
    if (found) return found;
  }
  return null;
}

/**
 * Search consolidated steps by friendly name or context
 */
export function searchConsolidatedSteps(steps: ConsolidatedStep[], searchTerm: string): ConsolidatedStep[] {
  if (!searchTerm || !searchTerm.trim()) return steps;
  const term = searchTerm.toLowerCase();

  return steps.filter(step => {
    if (step.friendlyName.toLowerCase().includes(term)) return true;
    if (step.context?.toLowerCase().includes(term)) return true;
    if (step.startStep.payload.name?.toLowerCase().includes(term)) return true;
    if (step.startStep.function_ancestry.function_name.toLowerCase().includes(term)) return true;
    // Recurse into children
    if (step.children.length > 0) {
      const matchingChildren = searchConsolidatedSteps(step.children, searchTerm);
      if (matchingChildren.length > 0) return true;
    }
    return false;
  });
}

/**
 * Convert old intermediate step format to new format (for migration)
 */
export function migrateOldStepFormat(oldStep: any): IntermediateStep | null {
  try {
    // Basic validation
    if (!oldStep || typeof oldStep !== 'object') return null;

    // Map old type to new event type
    let eventType: IntermediateStepType = IntermediateStepType.CUSTOM_START;
    if (oldStep.type === 'system_intermediate') {
      if (oldStep.status === 'completed') {
        eventType = IntermediateStepType.CUSTOM_END;
      }
    }

    // Create new format step
    const newStep: IntermediateStep = {
      parent_id: oldStep.parent_id || 'root',
      function_ancestry: {
        node_id: oldStep.id || 'unknown',
        parent_id: oldStep.parent_id || null,
        function_name: oldStep.content?.name || 'Unknown Function',
        depth: 0
      },
      payload: {
        event_type: eventType,
        event_timestamp: oldStep.time_stamp || Date.now() / 1000,
        name: oldStep.content?.name || oldStep.name || 'Migrated Step',
        metadata: {
          migrated: true,
          original_data: oldStep
        },
        data: {
          output: oldStep.content?.payload || oldStep.content
        },
        UUID: oldStep.id || `migrated-${Date.now()}-${Math.random()}`
      }
    };

    return newStep;
  } catch (error) {
    console.error('Error migrating old step format:', error);
    return null;
  }
}
