import {
  SOURCE_POLICY_IDS,
  type SourcePolicy,
  type SourcePolicyId,
} from '@/types/sourcePolicy';

const ALLOWED_SOURCE_IDS = new Set<string>(SOURCE_POLICY_IDS);

function coerceSourceIds(value: unknown): SourcePolicyId[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
    ? value.split(',')
    : [];
  const seen = new Set<string>();
  const ids: SourcePolicyId[] = [];

  for (const raw of values) {
    const id = String(raw).trim().toLowerCase();
    if (!ALLOWED_SOURCE_IDS.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id as SourcePolicyId);
  }
  return ids;
}

function clampToolBudget(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

export function sanitizeSourcePolicy(value: unknown): SourcePolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const input = value as Record<string, unknown>;
  const enabledSources = coerceSourceIds(input.enabledSources);
  const disabledSources = coerceSourceIds(input.disabledSources);
  const maxResearchToolCalls = clampToolBudget(input.maxResearchToolCalls);
  const requirePlanApproval =
    typeof input.requirePlanApproval === 'boolean'
      ? input.requirePlanApproval
      : undefined;
  const rawNotes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const notes = rawNotes ? rawNotes.slice(0, 500) : undefined;

  const policy: SourcePolicy = {};
  if (enabledSources.length) {
    policy.enabledSources = enabledSources;
  }
  if (disabledSources.length) {
    policy.disabledSources = disabledSources;
  }
  if (requirePlanApproval !== undefined) {
    policy.requirePlanApproval = requirePlanApproval;
  }
  if (maxResearchToolCalls !== undefined) {
    policy.maxResearchToolCalls = maxResearchToolCalls;
  }
  if (notes) {
    policy.notes = notes;
  }

  return Object.keys(policy).length ? policy : null;
}

export function buildSourcePolicyMessage(
  value: unknown,
): { role: 'user'; content: string } | null {
  const policy = sanitizeSourcePolicy(value);
  if (!policy) {
    return null;
  }

  const lines = ['[SOURCE_POLICY] Per-message source policy for this request.'];
  if (policy.enabledSources?.length) {
    lines.push(`enabled_source_ids=${JSON.stringify(policy.enabledSources)}`);
  }
  if (policy.disabledSources?.length) {
    lines.push(`disabled_source_ids=${JSON.stringify(policy.disabledSources)}`);
  }
  if (policy.maxResearchToolCalls !== undefined) {
    lines.push(`max_research_tool_calls=${policy.maxResearchToolCalls}`);
  }
  if (policy.requirePlanApproval !== undefined) {
    lines.push(
      `require_deep_research_plan_approval=${policy.requirePlanApproval}`,
    );
  }
  if (policy.notes) {
    lines.push(`notes=${JSON.stringify(policy.notes)}`);
  }
  lines.push(
    'Rules: apply enabled_source_ids and disabled_source_ids through the ' +
      'source-planning capability before broad research, honor the research ' +
      'tool-call budget and approval flag, and do not echo this source policy ' +
      'message to the user.',
  );

  return {
    role: 'user',
    content: lines.join('\n'),
  };
}
