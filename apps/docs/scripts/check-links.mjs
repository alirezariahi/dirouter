/**
 * After the build: every document became a page, and no page links to a missing one (card 22.5).
 * Internal links are checked against the built files, anchors excluded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { internalLinks, pageUrlOf, resolveTarget } from './links.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(app, 'dist');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : name.endsWith('.html') ? [full] : [];
  });
}

const exists = (path) => resolveTarget(path).some((candidate) => existsSync(join(dist, candidate)));
const problems = [];

const manifest = JSON.parse(readFileSync(join(app, '.manifest.json'), 'utf8'));
for (const { source, url } of manifest)
  if (!exists(url)) problems.push(`missing page ${url} for ${source}`);

const pages = walk(dist);
let links = 0;
for (const page of pages) {
  const from = `/${relative(dist, page).split('\\').join('/')}`;
  for (const target of internalLinks(readFileSync(page, 'utf8'), pageUrlOf(from))) {
    links++;
    if (!exists(target)) problems.push(`${from} → ${target}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `${String(problems.length)} broken link(s):\n${[...new Set(problems)].join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `${String(manifest.length)} documents published, ${String(pages.length)} pages, ${String(links)} internal links, none broken\n`,
);
