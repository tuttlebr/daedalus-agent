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
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;

  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
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
