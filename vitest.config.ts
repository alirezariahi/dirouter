import { defineConfig } from 'vitest/config';

import { testCoverage } from './vitest.shared.js';

export default defineConfig({
  test: { coverage: testCoverage() },
});
