import { defineConfig } from 'vitest/config';

/**
 * Every package measures its own source tree. Process entrypoints, generated
 * clients and test fixtures are not useful unit-test coverage targets.
 */
export const testCoverage = (threshold = 70) => ({
  provider: 'v8' as const,
  include: ['src/**/*.{ts,tsx}'],
  exclude: [
    'src/**/*.test.{ts,tsx}',
    'src/**/__fixtures__/**',
    'src/main.{ts,tsx}',
    'src/seed.ts',
    'src/export-openapi.ts',
    'src/api/generated.ts',
    'src/index.ts',
  ],
  reportsDirectory: './coverage',
  reporter: ['text', 'json-summary', 'html', 'lcov'],
  thresholds: {
    statements: threshold,
    branches: threshold,
    functions: threshold,
    lines: threshold,
  },
});

export default defineConfig({
  test: {
    coverage: testCoverage(),
  },
});
