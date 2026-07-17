import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next.js keeps JSX for its compiler (`jsx: preserve`), so make the
  // test-only JSX transform explicit.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.node_modules-root-owned-*/**',
      'e2e/**',
    ],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'utils/**/*.ts',
        'components/**/*.tsx',
        'services/**/*.ts',
        'hooks/**/*.ts',
        'pages/api/**/*.ts',
        'ws-server.ts',
        'server/autonomy/store.ts',
        'server/chat/**/*.ts',
        'server/documentObjectStore.ts',
        'server/milvusMetadata.ts',
        'server/multipartDocument.ts',
        'server/rateLimit.ts',
        'server/session/**/*.ts',
        'state/conversationStore.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        'node_modules/**',
      ],
      thresholds: {
        // Measured repository-wide regression gates. The explicit server and
        // state entries above keep newly hardened trust boundaries visible in
        // the report instead of allowing uninstrumented code to look green.
        lines: 36,
        functions: 28,
        branches: 28,
        statements: 34,
        // Critical runtime areas use measured floors in addition to the
        // repository-wide gate, so broad aggregate coverage can't mask a
        // regression in authentication, rate limiting, or state lifecycles.
        'ws-server.ts': {
          lines: 43,
          functions: 34,
          branches: 43,
          statements: 43,
        },
        'server/autonomy/store.ts': {
          lines: 73,
          functions: 62,
          branches: 58,
          statements: 69,
        },
        'server/rateLimit.ts': {
          lines: 100,
          functions: 100,
          branches: 87,
          statements: 100,
        },
        'server/session/**/*.ts': {
          lines: 36,
          functions: 36,
          branches: 30,
          statements: 35,
        },
      },
    },
  },
});
