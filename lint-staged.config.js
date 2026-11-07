export default {
  '*.{ts,tsx,js,mjs,cjs}': ['prettier --write', 'eslint --fix --no-warn-ignored'],
  '*.{json,md,yml,yaml,css,html}': ['prettier --write'],
};
