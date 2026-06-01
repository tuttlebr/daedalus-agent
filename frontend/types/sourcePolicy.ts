export const SOURCE_POLICY_IDS = [
  'curated_domains',
  'curated_feeds',
  'google_search',
  'known_url_scrape',
  'nvidia_docs',
  'uploaded_documents',
  'workspace_data',
] as const;

export type SourcePolicyId = (typeof SOURCE_POLICY_IDS)[number];

export interface SourcePolicy {
  enabledSources?: SourcePolicyId[];
  disabledSources?: SourcePolicyId[];
  requirePlanApproval?: boolean;
  maxResearchToolCalls?: number;
  notes?: string;
}
