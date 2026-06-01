import { sanitizeConfigPatch } from '@/server/autonomy/store';
import { describe, expect, it } from 'vitest';

describe('autonomy store config sanitization', () => {
  it('whitelists and clamps source policy fields', () => {
    expect(
      sanitizeConfigPatch({
        sourcePolicy: {
          enabledSources: ['curated_domains', 'missing'] as any,
          disabledSources: ['google_search'],
          maxResearchToolCalls: 99,
          requirePlanApproval: true,
          notes: 'Stay on primary sources.',
        },
      }),
    ).toEqual({
      sourcePolicy: {
        enabledSources: ['curated_domains'],
        disabledSources: ['google_search'],
        maxResearchToolCalls: 20,
        requirePlanApproval: true,
        notes: 'Stay on primary sources.',
      },
    });
  });

  it('drops empty source policy patches', () => {
    expect(
      sanitizeConfigPatch({
        sourcePolicy: {
          enabledSources: ['not-a-source'] as any,
        },
      }),
    ).toEqual({});
  });
});
