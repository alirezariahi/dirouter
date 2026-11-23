/**
 * Generates src/content/docs from the repository's docs/ and adr/ folders and the API reference
 * from the exported OpenAPI document. The generated folder is not committed.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiReference } from './openapi.mjs';
import { contentFile, sitePath, SOURCES, toPage } from './sync-lib.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '../..');
const out = join(app, 'src/content/docs');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : name.endsWith('.md') ? [full] : [];
  });
}

const files = SOURCES.flatMap(({ dir }) => walk(join(root, dir))).map((f) =>
  relative(root, f).split('\\').join('/'),
);
const known = new Set(files);
rmSync(out, { recursive: true, force: true });

const manifest = [];
for (const repoPath of files) {
  const target = contentFile(repoPath);
  if (!target) continue;
  const dest = join(out, target);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, toPage(readFileSync(join(root, repoPath), 'utf8'), repoPath, known));
  manifest.push({
    source: repoPath,
    url: `${target.startsWith('fa/') ? '/fa' : ''}/${sitePath(repoPath) ?? ''}`,
  });
}

// API reference, generated from the control-api's OpenAPI document.
const openapi = JSON.parse(readFileSync(join(root, 'apps/dashboard/openapi.json'), 'utf8'));
for (const locale of ['en', 'fa']) {
  const dest = join(out, locale === 'fa' ? 'fa/api/reference.md' : 'api/reference.md');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, apiReference(openapi, locale));
  manifest.push({
    source: 'apps/dashboard/openapi.json',
    url: `${locale === 'fa' ? '/fa' : ''}/api/reference`,
  });
}

writeFileSync(join(app, '.manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(`synced ${String(manifest.length)} pages\n`);
