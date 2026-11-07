import { react } from '@dirouter/eslint-config';

// خروجی orval تولیدی است و دستی ویرایش نمی‌شود.
export default [{ ignores: ['src/api/generated.ts'] }, ...react];
