import { defineConfig } from 'vitest/config';

import { testCoverage } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    coverage: {
      ...testCoverage(),
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
        'src/router.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
