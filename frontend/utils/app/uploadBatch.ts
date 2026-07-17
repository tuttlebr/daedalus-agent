export type UploadKind = 'image' | 'document' | 'video' | 'transcript';

export type UploadKindCounts = Record<UploadKind, number>;

export interface UploadBatchAdmission<T> {
  accepted: T[];
  rejected: UploadKindCounts;
}

/** Apply every per-kind limit before any file enters the upload queue. */
export function admitUploadBatch<T>(
  candidates: readonly T[],
  classify: (candidate: T) => UploadKind,
  existing: UploadKindCounts,
  limits: UploadKindCounts,
): UploadBatchAdmission<T> {
  const accepted: T[] = [];
  const admitted: UploadKindCounts = {
    image: 0,
    document: 0,
    video: 0,
    transcript: 0,
  };
  const rejected: UploadKindCounts = {
    image: 0,
    document: 0,
    video: 0,
    transcript: 0,
  };

  for (const candidate of candidates) {
    const kind = classify(candidate);
    if (existing[kind] + admitted[kind] >= limits[kind]) {
      rejected[kind] += 1;
      continue;
    }
    admitted[kind] += 1;
    accepted.push(candidate);
  }

  return { accepted, rejected };
}
