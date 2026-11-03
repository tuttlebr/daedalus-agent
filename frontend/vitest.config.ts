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
    setupFiles: ['./__tests__/setupDom.ts'],
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
        'hooks/**/*.{ts,tsx}',
        'pages/api/**/*.ts',
        'ws-server.ts',
        'stream-worker.ts',
        // Every server module and client store, including job admission,
        // atomic JSON/history writers and OAuth state.
        'server/**/*.ts',
        'state/**/*.ts',
        // Runtime helpers outside the directories above: upload limits,
        // activity classification, component utilities and the page shell.
        'components/**/*.ts',
        'constants/**/*.ts',
        'types/**/*.ts',
        'pages/*.tsx',
        // Build and CI policy scripts, including the production dependency
        // audit gate, whose tests live beside them as *.test.mjs.
        'scripts/**/*.{js,mjs}',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.test.mjs',
        '**/*.d.ts',
        'node_modules/**',
      ],
      thresholds: {
        // Measured repository-wide regression gates, kept within a few points
        // of the measured unit-run values so losing a meaningful share of the
        // suite fails the gate. The explicit server and state entries above
        // keep newly hardened trust boundaries visible in the report instead
        // of allowing uninstrumented code to look green.
        lines: 68,
        functions: 64,
        branches: 58,
        statements: 66,
        // Critical runtime areas use measured floors in addition to the
        // repository-wide gate, so broad aggregate coverage can't mask a
        // regression in authentication, rate limiting, or state lifecycles.
        'ws-server.ts': {
          lines: 60,
          functions: 45,
          branches: 58,
          statements: 60,
        },
        'server/autonomy/store.ts': {
          lines: 92,
          functions: 92,
          branches: 82,
          statements: 88,
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
