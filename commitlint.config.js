// Conventional Commits; the scope must be the name of an app or package, or a general area.
const scopes = [
  'gateway',
  'control-api',
  'worker',
  'dashboard',
  'mock-provider',
  'contracts',
  'shared',
  'db',
  'model-catalog',
  'ui',
  'tsconfig',
  'eslint-config',
  'deploy',
  'docs',
  'ci',
  'deps',
  'repo',
];

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', scopes],
    'subject-case': [0],
    'body-max-line-length': [1, 'always', 100],
  },
};
