import { isActiveRun } from '@/components/autonomy/utils';

import { describe, expect, it } from 'vitest';

describe('autonomy active run state', () => {
  it.each([
    ['queued', true],
    ['running', true],
    ['skipped', false],
    ['aborted', false],
    ['completed', false],
    ['failed', false],
  ])('classifies %s as active=%s', (status, expected) => {
    expect(isActiveRun({ status } as any)).toBe(expected);
  });
});
