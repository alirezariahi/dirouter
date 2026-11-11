import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectRoot = resolve(root, '..');
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', '.turbo', 'generated']);
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.template',
  '.yml',
  '.yaml',
]);
const schemaFiles = new Set([
  'packages/shared/src/env.ts',
  'apps/gateway/src/main.ts',
  'apps/control-api/src/env.ts',
  'apps/worker/src/env.ts',
  'apps/mock-provider/src/main.ts',
]);
const variablePattern = /^[A-Z][A-Z0-9_]*$/;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excludedDirectories.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return statSync(path).isFile() ? [path] : [];
  });
}

function add(result, name, file, source) {
  assert.match(name, variablePattern, `${file}: invalid environment variable name ${name}`);
  const current = result.get(name) ?? new Set();
  current.add(`${file}:${source}`);
  result.set(name, current);
}

/** Extract literal environment reads; dynamic access needs an explicit schema entry. */
export function discoverEnvironment(rootDirectory = root) {
  const discovered = new Map();
  for (const path of walk(rootDirectory)) {
    const file = relative(rootDirectory, path).replaceAll('\\', '/');
    const extension = path.slice(path.lastIndexOf('.'));
    if (file.startsWith('scripts/ci/env-docs')) continue;
    if (!sourceExtensions.has(extension) && !/^compose(?:\.[\w-]+)?\.ya?ml$/.test(file)) continue;
    const source = readFileSync(path, 'utf8');

    for (const match of source.matchAll(
      /(?:process|Bun)\.env(?:\s*\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]|\.([A-Z][A-Z0-9_]*))/g,
    )) {
      // This TSX file contains a Python usage example, not an actual Node environment read.
      if (
        file.includes('apps/website/src/components/Integration.tsx') &&
        match[2] === 'DIROUTER_API_KEY'
      ) {
        continue;
      }
      add(discovered, match[1] ?? match[2], file, 'direct read');
    }
    for (const match of source.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) {
      add(discovered, match[1], file, 'Vite read');
    }
    if (schemaFiles.has(file)) {
      for (const match of source.matchAll(/^\s{2,4}([A-Z][A-Z0-9_]*)\s*:\s*(?:z\.|env\w+\()/gm)) {
        add(discovered, match[1], file, 'Zod schema');
      }
      if (file === 'apps/gateway/src/main.ts') {
        for (const name of ['DATA_DIR', 'SHUTDOWN_DRAIN_MS', 'SHUTDOWN_READY_DELAY_MS']) {
          if (source.includes(`${name}:`)) add(discovered, name, file, 'Zod schema');
        }
      }
    }
    if (file === 'apps/mock-provider/src/main.ts' && source.includes('MOCK_DEFAULT:')) {
      add(discovered, 'MOCK_DEFAULT', file, 'Zod schema');
    }
    if (file === 'apps/control-api/src/seed.ts') {
      for (const name of ['SEED_MOCK_URL', 'SEED_CREDENTIALS_FILE', 'SEED_ADMIN_PASSWORD']) {
        if (source.includes(`env.${name}`)) add(discovered, name, file, 'env alias read');
      }
    }
    if (file === 'scripts/dev-snapshot.mjs' && source.includes('DEV_API_KEY')) {
      add(discovered, 'DEV_API_KEY', file, 'env destructuring');
    }
    if (file === 'deploy/docker/nginx/dashboard.conf.template') {
      add(discovered, 'DIROUTER_API_URL', file, 'nginx template');
    }
    if (file.startsWith('.github/workflows/')) {
      let envIndent;
      for (const line of source.split('\n')) {
        const block = /^(\s*)env:\s*$/.exec(line);
        if (block) {
          envIndent = block[1].length;
          continue;
        }
        if (envIndent === undefined || !line.trim() || line.trimStart().startsWith('#')) continue;
        const indent = /^\s*/.exec(line)[0].length;
        if (indent <= envIndent) {
          envIndent = undefined;
          continue;
        }
        const variable = /^([A-Z][A-Z0-9_]*):(?:\s|$)/.exec(line.trimStart());
        if (variable) add(discovered, variable[1], file, 'workflow env');
      }
    }
    if (file === 'CI.md') {
      for (const name of ['TURBO_TELEMETRY_DISABLED', 'HUSKY']) {
        if (source.includes(`\`${name}`)) add(discovered, name, file, 'CI tool environment');
      }
    }
    if (file.startsWith('compose')) {
      for (const match of source.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)(?::[-?]|\})/g)) {
        add(discovered, match[1], file, 'Compose interpolation');
      }
    }
  }
  return new Map([...discovered].sort(([a], [b]) => a.localeCompare(b)));
}

/** The contract is one inline-code variable per line; prose mentioning a name is not enough. */
export function documentedVariables(document) {
  return new Set(
    [...document.matchAll(/^\s*(?:[-*]|\|)?\s*`([A-Z][A-Z0-9_]*)`/gm)].map((match) => match[1]),
  );
}

export function check({
  rootDirectory = root,
  referencePath = join(projectRoot, 'docs/env-reference.md'),
} = {}) {
  const discovered = discoverEnvironment(rootDirectory);
  const documented = documentedVariables(readFileSync(referencePath, 'utf8'));
  const missing = [...discovered.keys()].filter((name) => !documented.has(name));
  const unknown = [...documented].filter((name) => !discovered.has(name));
  return { discovered, documented, missing, unknown };
}

export function run(result = check()) {
  if (result.missing.length || result.unknown.length) {
    if (result.missing.length) {
      process.stderr.write(`Undocumented environment variables: ${result.missing.join(', ')}\n`);
    }
    if (result.unknown.length) {
      process.stderr.write(
        `Documented variables no longer read by the source: ${result.unknown.join(', ')}\n`,
      );
    }
    process.stderr.write(
      'Update docs/env-reference.md in the same change as the environment consumer.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Environment reference verified: ${String(result.discovered.size)} variables, no missing or stale entries.\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run();
}
