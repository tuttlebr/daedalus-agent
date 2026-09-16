import { MODEL_PROFILES } from '@/types/modelProfile';

/** Validate untrusted JSON before creating a job; preserve all unrelated fields. */
export function validateModelProfile(additionalProps: unknown): string | null {
  if (additionalProps === undefined || additionalProps === null) return null;
  if (typeof additionalProps !== 'object' || Array.isArray(additionalProps)) {
    return 'additionalProps must be an object';
  }
  if (!Object.prototype.hasOwnProperty.call(additionalProps, 'model_profile')) {
    return null;
  }
  const profile = (additionalProps as Record<string, unknown>).model_profile;
  return typeof profile === 'string' &&
    MODEL_PROFILES.some((candidate) => candidate === profile)
    ? null
    : 'model_profile must be default, deep, or deep_max';
}
