import { node } from '@dirouter/eslint-config';

// Root files only; each app and package has its own eslint.config.js.
export default [
  { ignores: ['apps/**', 'packages/**'] },
  ...node,
  {
    files: ['scripts/bench/k6-*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' },
    },
  },
];
