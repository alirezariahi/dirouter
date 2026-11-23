/** Internal link extraction and resolution for the link check. */

/**
 * Site-internal targets of href and src attributes in a page served at `pageUrl` (e.g.
 * `/fa/ci/`): absolute paths as they are, relative ones resolved against the page, both without
 * query or anchor. External links and in-page anchors are skipped.
 */
export function internalLinks(html, pageUrl = '/') {
  const out = new Set();
  for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const value = (match[1] ?? '').replaceAll('&amp;', '&');
    if (value === '' || value.startsWith('#') || value.startsWith('//')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    const resolved = new URL(value, `https://site.invalid${pageUrl}`).pathname;
    out.add(decodeURI(resolved));
  }
  return [...out];
}

/** The URL a built file is served at: `/a/b/index.html` → `/a/b/`. */
export function pageUrlOf(file) {
  return `/${file.replace(/^\/+/, '')}`.replace(/index\.html$/, '');
}

/** The built files a site path may correspond to. */
export function resolveTarget(path) {
  const clean = path.replace(/^\/+/, '');
  if (clean === '' || path.endsWith('/')) return [`${clean}index.html`];
  return [clean, `${clean}/index.html`, `${clean}.html`];
}
