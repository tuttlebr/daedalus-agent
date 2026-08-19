import {
  admitUploadBatch,
  type UploadKind,
  type UploadKindCounts,
} from '@/utils/app/uploadBatch';

import { describe, expect, it } from 'vitest';

const limits: UploadKindCounts = {
  image: 2,
  document: 3,
  video: 1,
};

describe('admitUploadBatch', () => {
  it('enforces every file-kind limit in one mixed selection', () => {
    const candidates: UploadKind[] = [
      'image',
      'image',
      'image',
      'document',
      'document',
      'video',
      'video',
    ];

    const result = admitUploadBatch(
      candidates,
      (candidate) => candidate,
      { image: 0, document: 2, video: 0 },
      limits,
    );

    expect(result.accepted).toEqual(['image', 'image', 'document', 'video']);
    expect(result.rejected).toEqual({
      image: 1,
      document: 1,
      video: 1,
    });
  });

  it('does not mutate caller-owned count objects', () => {
    const existing: UploadKindCounts = {
      image: 1,
      document: 0,
      video: 0,
    };

    admitUploadBatch(
      ['image'],
      (candidate) => candidate as UploadKind,
      existing,
      limits,
    );

    expect(existing).toEqual({
      image: 1,
      document: 0,
      video: 0,
    });
  });
});
