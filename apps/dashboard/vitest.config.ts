import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import { testCoverage } from '../../vitest.shared.js';
import baseConfig from './vite.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { environment: 'jsdom', globals: false, css: false, coverage: testCoverage() },
  }),
);
