/**
 * Turns the repository's Markdown (docs/ and adr/) into Starlight pages (card 22.5).
 *
 * - Each `name.md` becomes one page; README is the index.
 * - The first H1 becomes the page title.
 * - Links between documents become site URLs; links to anything else in the repository point to
 *   GitHub, so nothing on the site leads to a missing page.
 */
import { posix } from 'node:path';

export const REPOSITORY = 'https://github.com/alirezariahi/dirouter/blob/main';

/** Source folders and where their pages live on the site. */
export const SOURCES = [
  { dir: 'docs', base: '' },
  { dir: 'adr', base: 'decisions' },
];

/** Site path (no leading slash) of a repository Markdown file, or undefined. */
export function sitePath(repoPath) {
  const source = SOURCES.find(({ dir }) => repoPath.startsWith(`${dir}/`));
  if (!source || !repoPath.endsWith('.md')) return undefined;
  const rel = repoPath.slice(source.dir.length + 1).replace(/\.md$/, '');
  const parts = rel.split('/');
  if (/^readme$/i.test(parts.at(-1) ?? '')) parts.pop();
  const path = [source.base, ...parts].filter(Boolean).join('/');
  return path.toLowerCase();
}

export const siteUrl = (path) => `/${path ? `${path}/` : ''}`;

/** Where a page file goes inside src/content/docs. */
export function contentFile(repoPath) {
  const path = sitePath(repoPath);
  if (path === undefined) return undefined;
  return path ? `${path}.md` : 'index.md';
}

/** Rewrites one link target found in `fromRepoPath`. */
export function rewriteLink(target, fromRepoPath, known) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
  const [pathPart, hash = ''] = target.split('#');
  if (!pathPart) return target;
  const resolved = posix.normalize(posix.join(posix.dirname(fromRepoPath), decodeURI(pathPart)));
  const anchor = hash ? `#${hash}` : '';
  if (resolved.startsWith('..')) return target;
  if (resolved.endsWith('.md') && known.has(resolved)) {
    const path = sitePath(resolved);
    if (path !== undefined) return `${siteUrl(path)}${anchor}`;
  }
  // A folder link to a documented folder goes to its index page.
  if (known.has(`${resolved.replace(/\/$/, '')}/README.md`) && !resolved.endsWith('.md')) {
    const path = sitePath(`${resolved.replace(/\/$/, '')}/README.md`);
    if (path !== undefined) return `${siteUrl(path)}${anchor}`;
  }
  return `${REPOSITORY}/${resolved}${anchor}`;
}

/** Markdown links and images outside code: `[text](target)` and `![alt](target)`. */
function rewriteLinks(markdown, fromRepoPath, known) {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // Links may have code in their text ([`file`](path)); a match that starts inside a
      // standalone code span is code, not a link.
      const code = [...line.matchAll(/`[^`]*`/g)].map((m) => [m.index, m.index + m[0].length]);
      return line.replace(
        /(!?\[(?:[^\]`]|`[^`]*`)*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
        (match, open, target, close, offset) =>
          code.some(([from, to]) => offset > from && offset < to)
            ? match
            : `${open}${rewriteLink(target, fromRepoPath, known)}${close}`,
      );
    })
    .join('\n');
}

/** A repository Markdown file as a Starlight page. */
export function toPage(markdown, repoPath, known) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title;
  const kept = [];
  for (const line of lines) {
    if (title === undefined && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }
    kept.push(line);
  }
  title ??= posix.basename(repoPath).replace(/\.md$/, '');
  const body = rewriteLinks(kept.join('\n').replace(/^\n+/, ''), repoPath, known);
  const source = `${REPOSITORY}/${repoPath}`;
  return `---\ntitle: ${JSON.stringify(title)}\neditUrl: ${JSON.stringify(source)}\n---\n\n${body}\n`;
}
