import type { ImageContext } from '@/types/imageBrief';

export const imageContext: ImageContext = {
  originalPrompt: 'A watercolor bird',
  prompt: 'Medium: watercolor\nSubject: bird\nPreserve: palette',
  guidance: 'assisted',
  skillVersion: 'test-version',
  params: { quality: 'high', output_format: 'webp', background: 'transparent' },
  inputImages: [],
  brief: {
    scene: '',
    subject: 'bird',
    medium: 'watercolor',
    composition: '',
    lighting: '',
    details: [],
    exact_text: [],
    changes: [],
    preserve: ['palette'],
    exclusions: [],
    intended_use: '',
    references: [],
    options: { quality: 'high' },
  },
};
