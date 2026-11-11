import { node } from '@dirouter/eslint-config';

// فقط فایل‌های ریشه؛ هر اپ و پکیج eslint.config.js خودش را دارد.
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
