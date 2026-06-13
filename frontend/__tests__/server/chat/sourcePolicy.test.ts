import {
  buildSourcePolicyMessage,
  sanitizeSourcePolicy,
} from '@/server/chat/sourcePolicy';
import { describe, expect, it } from 'vitest';

describe('sourcePolicy', () => {
  it('sanitizes source IDs and clamps tool budget', () => {
    expect(
      sanitizeSourcePolicy({
        enabledSources: ['curated_domains', 'missing', 'CURATED_DOMAINS'],
        disabledSources: 'perplexity_search,unknown',
        maxResearchToolCalls: 99,
        requirePlanApproval: true,
        notes: 'Use primary sources.',
      }),
    ).toEqual({
      enabledSources: ['curated_domains'],
      disabledSources: ['perplexity_search'],
      maxResearchToolCalls: 20,
      requirePlanApproval: true,
      notes: 'Use primary sources.',
    });
  });

  it('builds a hidden source-policy message for NAT', () => {
    const message = buildSourcePolicyMessage({
      enabledSources: ['curated_feeds', 'known_url_scrape'],
      disabledSources: ['perplexity_search'],
      maxResearchToolCalls: 6,
      requirePlanApproval: true,
    });

    expect(message?.role).toBe('user');
    expect(message?.content).toContain('[SOURCE_POLICY]');
    expect(message?.content).toContain('enabled_source_ids=');
    expect(message?.content).toContain('disabled_source_ids=');
    expect(message?.content).toContain('source-planning capability');
    expect(message?.content).not.toContain('source_policy_tool.plan_sources');
    expect(message?.content).not.toContain('research_agent');
    expect(message?.content).not.toContain('deep_research_agent');
    expect(message?.content).toContain(
      'require_deep_research_plan_approval=true',
    );
  });

  it('omits empty or fully invalid policy input', () => {
    expect(
      buildSourcePolicyMessage({ enabledSources: ['missing'] }),
    ).toBeNull();
    expect(buildSourcePolicyMessage(null)).toBeNull();
  });
});
