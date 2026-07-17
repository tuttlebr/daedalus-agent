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
        'server/chat/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        'node_modules/**',
      ],
      thresholds: {
        // Honest repository-wide baselines. CI runs the instrumented suite,
        // so these are regression gates rather than inactive aspirational
        // numbers. Raise them as the remaining UI surfaces gain tests.
        lines: 34,
        functions: 26,
        branches: 27,
        statements: 33,
      },
    },
  },
});
