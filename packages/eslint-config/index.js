// پیکربندی مشترک ESLint برای همهٔ اپ‌ها و پکیج‌ها (flat config).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ignores = {
  ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'],
};

/** قواعد پایهٔ TypeScript با type-aware linting. */
const typescript = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // ماژول‌های NestJS کلاس خالیِ دکوریت‌شده‌اند.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // mockهای async بدون await در تست طبیعی‌اند.
      '@typescript-eslint/require-await': 'off',
    },
  },
);

/** پیکربندی اپ‌ها و پکیج‌های Node. */
export const node = [
  ignores,
  ...typescript,
  { languageOptions: { globals: globals.node } },
  prettier,
];

/** پیکربندی اپ‌ها و پکیج‌های React. */
export const react = [
  ignores,
  ...typescript,
  {
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  prettier,
];

export default node;
