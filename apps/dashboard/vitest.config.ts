import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import { testCoverage } from '../../vitest.shared.js';
import baseConfig from './vite.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: false,
      css: false,
      setupFiles: ['./src/test-setup.ts'],
      // Room for the longer async waits configured in the setup file.
      testTimeout: 30_000,
      coverage: testCoverage(),
    },
  }),
);
