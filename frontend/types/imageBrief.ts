import type { ImageParams } from '@/utils/app/imageModelCapabilities';

export interface ImageBrief {
  scene: string;
  subject: string;
  medium: string;
  composition: string;
  lighting: string;
  details: string[];
  exact_text: string[];
  changes: string[];
  preserve: string[];
  exclusions: string[];
  intended_use: string;
  references: string[];
  options: ImageParams;
}

export interface ImageContext {
  preparationMs?: number;
  originalPrompt: string;
  prompt: string;
  brief: ImageBrief;
  params: ImageParams;
  inputImages: Array<{
    imageId: string;
    sessionId?: string;
    mimeType?: string;
  }>;
  skillVersion?: string | null;
  guidance: 'assisted' | 'exact' | 'fallback';
  warning?: string | null;
}
