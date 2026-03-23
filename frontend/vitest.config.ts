import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['utils/**/*.ts', 'components/**/*.tsx', 'services/**/*.ts', 'hooks/**/*.ts', 'pages/api/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', 'node_modules/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
