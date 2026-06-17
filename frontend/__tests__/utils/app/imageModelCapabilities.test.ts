import {
  cleanImageParamsForModel,
  validateImageSize,
  validateImageParamsForSubmit,
} from '@/utils/app/imageModelCapabilities';

import { describe, expect, it } from 'vitest';

describe('image model capabilities', () => {
  it('cleans unsupported GPT Image 2 params', () => {
    expect(
      cleanImageParamsForModel(
        {
          quality: 'high',
          size: '2048x2048',
          output_format: 'webp',
          output_compression: 82.4,
          background: 'transparent',
          moderation: 'low',
          input_fidelity: 'high',
          n: 99,
        },
        'gpt-image-2',
      ),
    ).toEqual({
      quality: 'high',
      size: '2048x2048',
      output_format: 'webp',
      output_compression: 82,
      moderation: 'low',
      n: 8,
    });
  });

  it('drops compression when the output format does not support it', () => {
    expect(
      cleanImageParamsForModel({
        output_format: 'png',
        output_compression: 50,
      }),
    ).toEqual({ output_format: 'png' });
  });

  it('accepts valid popular and custom sizes', () => {
    expect(validateImageSize('1024x1024').valid).toBe(true);
    expect(validateImageSize('2048x1152').valid).toBe(true);
    expect(validateImageSize('1152x2048').valid).toBe(true);
    expect(validateImageSize('2048x3072').valid).toBe(true);
    expect(validateImageSize('3840x2160').valid).toBe(true);
  });

  it('rejects custom sizes that violate GPT Image 2 constraints', () => {
    expect(validateImageSize('1024x4096').reason).toContain('Maximum edge');
    expect(validateImageSize('1000x1000').reason).toContain('multiples of 16');
    expect(validateImageSize('512x512').reason).toContain('at least');
    expect(validateImageSize('3840x3840').reason).toContain('at most');
    expect(validateImageSize('3840x1024').reason).toContain('3:1');
  });

  it('validates request params before submit', () => {
    expect(validateImageParamsForSubmit({ size: '2048x2048' }).valid).toBe(
      true,
    );
    expect(validateImageParamsForSubmit({ size: '2048 by 2048' })).toEqual({
      valid: false,
      reason: 'Use WIDTHxHEIGHT, for example 2048x2048.',
    });
  });
});
