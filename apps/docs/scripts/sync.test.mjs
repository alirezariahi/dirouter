/** Documentation site: page conversion, link rewriting and the link check (card 22.5). */
import { describe, expect, it } from 'vitest';

import { internalLinks, pageUrlOf, resolveTarget } from './links.mjs';
import { apiReference } from './openapi.mjs';
import { contentFile, REPOSITORY, rewriteLink, sitePath, toPage } from './sync-lib.mjs';

const known = new Set([
  'docs/README.md',
  'docs/README.fa.md',
  'docs/ci.md',
  'docs/ci.fa.md',
  'docs/security/threat-model.md',
  'docs/security/threat-model.fa.md',
  'docs/user-guide/README.md',
  'adr/0007-data-plane-stays-on-node.md',
]);

describe('page paths', () => {
  it('maps docs/ to the root, adr/ to /decisions, README to the index and .fa to /fa', () => {
    expect(sitePath('docs/README.md')).toBe('');
    expect(sitePath('docs/CONTRIBUTING.md')).toBe('contributing');
    expect(sitePath('docs/security/threat-model.fa.md')).toBe('security/threat-model');
    expect(sitePath('adr/0007-data-plane-stays-on-node.md')).toBe(
      'decisions/0007-data-plane-stays-on-node',
    );
    expect(sitePath('apps/gateway/README.md')).toBeUndefined();
    expect(contentFile('docs/README.fa.md')).toBe('fa/index.md');
    expect(contentFile('docs/ci.md')).toBe('ci.md');
  });
});

describe('links', () => {
  it('turns document links into site URLs, keeping the language and the anchor', () => {
    expect(rewriteLink('ci.md#stages', 'docs/README.md', known)).toBe('/ci/#stages');
    expect(rewriteLink('ci.fa.md', 'docs/README.fa.md', known)).toBe('/fa/ci/');
    expect(
      rewriteLink(
        '../../adr/0007-data-plane-stays-on-node.md',
        'docs/security/threat-model.md',
        known,
      ),
    ).toBe('/decisions/0007-data-plane-stays-on-node/');
    expect(rewriteLink('user-guide/', 'docs/README.md', known)).toBe('/user-guide/');
  });

  it('sends links to other repository files to GitHub and leaves external links alone', () => {
    expect(rewriteLink('../scripts/ci/plan.mjs', 'docs/ci.md', known)).toBe(
      `${REPOSITORY}/scripts/ci/plan.mjs`,
    );
    expect(rewriteLink('https://example.com/x', 'docs/ci.md', known)).toBe('https://example.com/x');
    expect(rewriteLink('#local', 'docs/ci.md', known)).toBe('#local');
  });

  it('builds a page: title from the H1, no language switch, links rewritten, code untouched', () => {
    const page = toPage(
      [
        '[English](ci.md) · [فارسی](ci.fa.md)',
        '',
        '# CI "pipeline"',
        '',
        'See [`plan.mjs`](../scripts/ci/plan.mjs) and [the threat model](security/threat-model.md).',
        'Inline `[not](a-link.md)` stays.',
        '```md',
        '[also](not-a-link.md)',
        '```',
      ].join('\n'),
      'docs/ci.md',
      known,
    );
    expect(page).toContain('title: "CI \\"pipeline\\""');
    expect(page).not.toContain('[English]');
    expect(page).not.toContain('# CI');
    expect(page).toContain(`[\`plan.mjs\`](${REPOSITORY}/scripts/ci/plan.mjs)`);
    expect(page).toContain('[the threat model](/security/threat-model/)');
    expect(page).toContain('`[not](a-link.md)`');
    expect(page).toContain('[also](not-a-link.md)');
  });
});

describe('link check', () => {
  it('finds internal links, absolute and relative, and skips the rest', () => {
    const html =
      '<a href="/ci/#x">a</a><a href="../threat-model/">b</a><a href="https://x.test">c</a>' +
      '<a href="#top">d</a><img src="/favicon.svg"><a href="mailto:a@b.c">e</a>';
    expect(internalLinks(html, '/security/pentest/').sort()).toEqual([
      '/ci/',
      '/favicon.svg',
      '/security/threat-model/',
    ]);
    expect(pageUrlOf('/fa/ci/index.html')).toBe('/fa/ci/');
    expect(resolveTarget('/ci/')).toEqual(['ci/index.html']);
    expect(resolveTarget('/favicon.svg')).toContain('favicon.svg');
  });
});

describe('API reference', () => {
  it('lists operations by tag with their body fields, in both languages', () => {
    const doc = {
      info: { version: '1.0.0' },
      paths: {
        '/api/v1/orgs/{orgId}/keys': {
          get: { tags: ['keys'], summary: 'List keys' },
          post: {
            tags: ['keys'],
            summary: 'Create | a key',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/K' } } },
            },
          },
        },
      },
      components: {
        schemas: { K: { properties: { name: {}, projectId: {} }, required: ['name'] } },
      },
    };
    const en = apiReference(doc, 'en');
    expect(en).toContain('title: "Control API reference (1.0.0)"');
    expect(en).toContain('## keys');
    expect(en).toContain(
      '| `POST` | `/api/v1/orgs/{orgId}/keys` | Create \\| a key | `name`*, `projectId` |',
    );
    expect(apiReference(doc, 'fa')).toContain('مرجع API کنترل');
  });
});
