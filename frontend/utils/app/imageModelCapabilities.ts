export type ImageMode = 'generate' | 'edit';
export type ImageModel = 'gpt-image-2';

export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type ImageSize = 'auto' | `${number}x${number}`;
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
export type ImageBackground = 'transparent' | 'opaque' | 'auto';
export type ImageModeration = 'low' | 'auto';
export type ImageInputFidelity = 'low' | 'high';

export interface ImageParams {
  n?: number;
  quality?: ImageQuality;
  size?: ImageSize;
  output_format?: ImageOutputFormat;
  output_compression?: number;
  background?: ImageBackground;
  moderation?: ImageModeration;
  input_fidelity?: ImageInputFidelity;
}

export interface ImageSizeValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ImageModelCapabilities {
  model: ImageModel;
  label: string;
  qualities: readonly ImageQuality[];
  sizes: readonly ImageSize[];
  outputFormats: readonly ImageOutputFormat[];
  backgrounds: readonly ImageBackground[];
  moderation: readonly ImageModeration[];
  outputCounts: readonly number[];
  maxOutputs: number;
  supportsInputFidelity: boolean;
  customSize: {
    minPixels: number;
    maxPixels: number;
    maxEdge: number;
    multiple: number;
    maxRatio: number;
  };
}

export const DEFAULT_IMAGE_MODEL: ImageModel = 'gpt-image-2';

export const GPT_IMAGE_2_POPULAR_SIZES = [
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '2048x1152',
  '1152x2048',
  '1920x1080',
  '1080x1920',
  '2048x2048',
  '2048x3072',
  '3072x2048',
  '2560x1440',
  '1440x2560',
  '3840x2160',
  '2160x3840',
] as const satisfies readonly ImageSize[];

export const IMAGE_MODEL_CAPABILITIES: Record<
  ImageModel,
  ImageModelCapabilities
> = {
  'gpt-image-2': {
    model: 'gpt-image-2',
    label: 'GPT Image 2',
    qualities: ['auto', 'low', 'medium', 'high'],
    sizes: ['auto', ...GPT_IMAGE_2_POPULAR_SIZES],
    outputFormats: ['png', 'jpeg', 'webp'],
    backgrounds: ['auto', 'opaque'],
    moderation: ['auto', 'low'],
    outputCounts: [1, 2, 4, 8],
    maxOutputs: 8,
    supportsInputFidelity: false,
    customSize: {
      minPixels: 655_360,
      maxPixels: 8_294_400,
      maxEdge: 3840,
      multiple: 16,
      maxRatio: 3,
    },
  },
};

const PARAM_KEYS: (keyof ImageParams)[] = [
  'n',
  'quality',
  'size',
  'output_format',
  'output_compression',
  'background',
  'moderation',
  'input_fidelity',
];

export function isKnownImageModel(model: unknown): model is ImageModel {
  return typeof model === 'string' && model in IMAGE_MODEL_CAPABILITIES;
}

export function resolveImageModel(model: unknown): ImageModel {
  return isKnownImageModel(model) ? model : DEFAULT_IMAGE_MODEL;
}

export function getImageModelCapabilities(
  model: unknown,
): ImageModelCapabilities {
  return IMAGE_MODEL_CAPABILITIES[resolveImageModel(model)];
}

export function parseImageSize(
  size: unknown,
): { width: number; height: number } | null {
  if (typeof size !== 'string') return null;
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  return { width, height };
}

export function validateImageSize(
  size: unknown,
  model: unknown = DEFAULT_IMAGE_MODEL,
): ImageSizeValidationResult {
  if (size === undefined || size === null || size === '' || size === 'auto') {
    return { valid: true };
  }

  const parsed = parseImageSize(size);
  if (!parsed) {
    return { valid: false, reason: 'Use WIDTHxHEIGHT, for example 2048x2048.' };
  }

  const { width, height } = parsed;
  const caps = getImageModelCapabilities(model).customSize;
  if (width <= 0 || height <= 0) {
    return { valid: false, reason: 'Width and height must be positive.' };
  }
  if (width > caps.maxEdge || height > caps.maxEdge) {
    return { valid: false, reason: `Maximum edge is ${caps.maxEdge}px.` };
  }
  if (width % caps.multiple !== 0 || height % caps.multiple !== 0) {
    return {
      valid: false,
      reason: `Width and height must be multiples of ${caps.multiple}.`,
    };
  }

  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > caps.maxRatio) {
    return {
      valid: false,
      reason: `Aspect ratio must be ${caps.maxRatio}:1 or less.`,
    };
  }

  const pixels = width * height;
  if (pixels < caps.minPixels) {
    return {
      valid: false,
      reason: `Image must be at least ${caps.minPixels.toLocaleString()} pixels.`,
    };
  }
  if (pixels > caps.maxPixels) {
    return {
      valid: false,
      reason: `Image must be at most ${caps.maxPixels.toLocaleString()} pixels.`,
    };
  }

  return { valid: true };
}

export function validateImageParamsForSubmit(
  params: Record<string, unknown> | ImageParams | undefined,
  model: unknown = DEFAULT_IMAGE_MODEL,
): ImageSizeValidationResult {
  if (!params) return { valid: true };
  const source = params as ImageParams;
  return validateImageSize(source.size, model);
}

export function isPopularImageSize(
  size: unknown,
  model: unknown = DEFAULT_IMAGE_MODEL,
): size is ImageSize {
  return getImageModelCapabilities(model).sizes.includes(size as ImageSize);
}

export function cleanImageParamsForModel(
  params: Record<string, unknown> | ImageParams | undefined,
  model: unknown = DEFAULT_IMAGE_MODEL,
): ImageParams {
  const caps = getImageModelCapabilities(model);
  if (!params) return {};

  const cleaned: ImageParams = {};
  const source = params as ImageParams;

  if (source.n !== undefined) {
    const nextN = Number(source.n);
    if (Number.isInteger(nextN) && nextN >= 1) {
      cleaned.n = Math.min(nextN, caps.maxOutputs);
    }
  }

  if (source.quality !== undefined && caps.qualities.includes(source.quality)) {
    cleaned.quality = source.quality;
  }

  if (source.size !== undefined) {
    const size = source.size;
    if (size === 'auto' || validateImageSize(size, caps.model).valid) {
      cleaned.size = size;
    }
  }

  if (
    source.output_format !== undefined &&
    caps.outputFormats.includes(source.output_format)
  ) {
    cleaned.output_format = source.output_format;
  }

  if (
    source.output_compression !== undefined &&
    (cleaned.output_format === 'jpeg' || cleaned.output_format === 'webp')
  ) {
    const compression = Number(source.output_compression);
    if (Number.isFinite(compression)) {
      cleaned.output_compression = Math.max(
        0,
        Math.min(100, Math.round(compression)),
      );
    }
  }

  if (
    source.background !== undefined &&
    caps.backgrounds.includes(source.background)
  ) {
    cleaned.background = source.background;
  }

  if (
    source.moderation !== undefined &&
    caps.moderation.includes(source.moderation)
  ) {
    cleaned.moderation = source.moderation;
  }

  if (
    caps.supportsInputFidelity &&
    source.input_fidelity !== undefined &&
    (source.input_fidelity === 'low' || source.input_fidelity === 'high')
  ) {
    cleaned.input_fidelity = source.input_fidelity;
  }

  return cleaned;
}

export function removeImageParamKeys<T extends Record<string, unknown>>(
  body: T,
): Omit<T, keyof ImageParams> {
  const next = { ...body };
  for (const key of PARAM_KEYS) {
    delete next[key];
  }
  return next;
}
