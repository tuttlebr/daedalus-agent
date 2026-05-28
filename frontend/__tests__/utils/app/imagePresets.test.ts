import {
  IMAGE_PRESETS,
  applyPreset,
  presetsForMode,
} from '@/utils/app/imagePresets';

import { describe, expect, it } from 'vitest';

describe('image presets', () => {
  it('returns presets for the explicit mode', () => {
    expect(
      presetsForMode('generate').every((preset) =>
        preset.modes.includes('generate'),
      ),
    ).toBe(true);
    expect(
      presetsForMode('edit').every((preset) => preset.modes.includes('edit')),
    ).toBe(true);
  });

  it('cleans every preset for GPT Image 2', () => {
    for (const preset of IMAGE_PRESETS) {
      const applied = applyPreset(preset, 'an object', 'gpt-image-2');
      expect(applied.prompt).not.toContain('{{subject}}');
      expect(applied.params).not.toHaveProperty('input_fidelity');
      expect(applied.params.background).not.toBe('transparent');
    }
  });
});
