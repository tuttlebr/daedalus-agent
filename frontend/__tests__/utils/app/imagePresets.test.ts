import {
  IMAGE_PRESETS,
  applyPreset,
  presetsForMode,
} from '@/utils/app/imagePresets';

import { describe, expect, it } from 'vitest';

describe('image presets', () => {
  it('returns presets for the explicit mode', () => {
    expect(presetsForMode('generate').map((preset) => preset.id)).toEqual([
      'studio-headshot',
      'logo',
      'infographic',
      'product-shot',
    ]);
    expect(presetsForMode('edit').map((preset) => preset.id)).toEqual([
      'studio-headshot',
      'sketch-to-render',
      'virtual-try-on',
      'product-shot',
      'object-swap',
      'lighting-weather',
    ]);
  });

  it('cleans every preset for GPT Image 2.5 Sunburst', () => {
    for (const preset of IMAGE_PRESETS) {
      const applied = applyPreset(
        preset,
        'an object',
        'gpt-image-2.5-sunburst',
      );
      expect(applied.prompt).not.toContain('{{subject}}');
      expect(applied.params).not.toHaveProperty('input_fidelity');
      if (applied.params.background === 'transparent') {
        expect(['png', 'webp']).toContain(applied.params.output_format);
      }
    }
  });
});
