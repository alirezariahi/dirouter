import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/{rate-limiter,budget-guard,health-sync}.ts'],
      reportsDirectory: './coverage',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      thresholds: {
        'src/rate-limiter.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
