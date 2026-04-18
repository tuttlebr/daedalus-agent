/**
 * Prompt presets for the image panel, distilled from OpenAI's gpt-image-1.5
 * prompting guide. Each preset seeds the prompt and picks tuned defaults so
 * a user can click once and get guide-shaped output.
 */

import type { ImageMode, ImageParams } from '@/state/imagePanelStore';

export interface ImagePreset {
  id: string;
  label: string;
  description: string;
  modes: ImageMode[]; // which modes this preset applies to
  promptTemplate: string; // substituted into the prompt field; {{subject}} is user input
  preserveList?: string;
  params: ImageParams;
}

export const IMAGE_PRESETS: ImagePreset[] = [
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    description:
      'Shot like a 35 mm film photograph — soft natural light, shallow depth of field, subtle grain.',
    modes: ['generate', 'edit'],
    promptTemplate:
      'Photorealistic image of {{subject}}. Shot on 35mm film, 50mm lens at f/2.8, shallow depth of field, soft natural light, subtle film grain. No watermark, no extra text.',
    params: { quality: 'high', size: '1024x1024', output_format: 'png' },
  },
  {
    id: 'logo',
    label: 'Logo',
    description:
      'Original, non-infringing logo with clean vector-like shapes and strong silhouette.',
    modes: ['generate'],
    promptTemplate:
      'Original, non-infringing logo for {{subject}}. Clean, vector-like shapes, strong silhouette, balanced negative space. Reads clearly at both small and large sizes. Flat color palette, no gradients, no photorealistic elements, no text outside any intentional wordmark.',
    params: {
      quality: 'high',
      size: '1024x1024',
      background: 'transparent',
      n: 4,
    },
  },
  {
    id: 'sketch-to-render',
    label: 'Sketch → Render',
    description:
      'Convert a rough sketch into a finished render, preserving layout and perspective.',
    modes: ['edit'],
    promptTemplate:
      'Render the provided sketch as a finished image of {{subject}}. Preserve the exact layout, composition, and perspective of the sketch. Add realistic materials, lighting, and color; do not introduce any new elements or objects.',
    preserveList:
      'layout, composition, perspective, line-art proportions, object count',
    params: { quality: 'high', input_fidelity: 'high', size: '1024x1024' },
  },
  {
    id: 'virtual-try-on',
    label: 'Virtual Try-On',
    description:
      'Dress the person in the provided garment; lock identity, pose, and body shape.',
    modes: ['edit'],
    promptTemplate:
      'Dress the person in Image 1 in the garment shown in Image 2. Realistic fabric behavior, natural draping, correct fit. Match the lighting, shadows, and color temperature of Image 1.',
    preserveList:
      'face, facial features, skin tone, hair, body shape, pose, expression, identity, camera angle, background',
    params: { quality: 'high', input_fidelity: 'high', size: '1024x1536' },
  },
  {
    id: 'infographic',
    label: 'Infographic',
    description: 'Dense, text-heavy explanatory graphic. High quality required.',
    modes: ['generate'],
    promptTemplate:
      'Detailed infographic explaining {{subject}}. Use clear sectioning, labeled arrows, icons, and concise callouts. Legible sans-serif typography. Neutral background, restrained color palette. All text spelled correctly.',
    params: { quality: 'high', size: '1024x1536', output_format: 'png' },
  },
  {
    id: 'product-shot',
    label: 'Product Shot',
    description: 'Studio product photograph on seamless backdrop.',
    modes: ['generate', 'edit'],
    promptTemplate:
      'Studio product photograph of {{subject}}. Seamless neutral backdrop, soft key light from camera left, subtle fill, gentle rim light. Sharp focus on the product, tack-sharp detail on materials and finish. No hands, no people, no text.',
    params: {
      quality: 'high',
      size: '1024x1024',
      output_format: 'png',
      background: 'opaque',
    },
  },
  {
    id: 'object-swap',
    label: 'Object Swap',
    description:
      'Replace a specific object while preserving camera angle, shadows, and surroundings.',
    modes: ['edit'],
    promptTemplate:
      'Change only {{subject}} in the provided image. Keep everything else exactly the same — camera angle, composition, lighting, shadows, reflections, and all surrounding objects.',
    preserveList:
      'camera angle, composition, lighting, shadows, reflections, every object except the target',
    params: { quality: 'high', input_fidelity: 'high' },
  },
  {
    id: 'lighting-weather',
    label: 'Lighting / Weather',
    description:
      'Change time-of-day, season, or weather; preserve geometry and identity.',
    modes: ['edit'],
    promptTemplate:
      'Change the lighting/weather of the provided image to {{subject}}. Modify only environmental conditions (time of day, season, precipitation, atmosphere). Preserve all geometry, subjects, and layout.',
    preserveList:
      'geometry, subjects, identity, layout, camera angle, composition',
    params: { quality: 'high', input_fidelity: 'high' },
  },
];

export function applyPreset(
  preset: ImagePreset,
  userSubject: string,
): { prompt: string; preserveList?: string; params: ImageParams } {
  const subject = userSubject.trim() || '[describe your subject]';
  return {
    prompt: preset.promptTemplate.replace(/\{\{subject\}\}/g, subject),
    preserveList: preset.preserveList,
    params: preset.params,
  };
}

export function presetsForMode(mode: ImageMode): ImagePreset[] {
  return IMAGE_PRESETS.filter((p) => p.modes.includes(mode));
}
