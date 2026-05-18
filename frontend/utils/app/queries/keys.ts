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
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversations', id] as const,
  },
  session: {
    registry: ['session', 'registry'] as const,
  },
} as const;
