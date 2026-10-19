export const queryKeys = {
  auth: {
    me: ['auth', 'me'] as const,
  },
  milvus: {
    collections: ['milvus', 'collections'] as const,
  },
  images: {
    history: ['images', 'history'] as const,
  },
} as const;
