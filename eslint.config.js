import { node } from '@dirouter/eslint-config';

// فقط فایل‌های ریشه؛ هر اپ و پکیج eslint.config.js خودش را دارد.
export default [{ ignores: ['apps/**', 'packages/**'] }, ...node];
