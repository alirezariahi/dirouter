// Documentation site (card 22.5): English only.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.DOCS_SITE_URL ?? 'https://docs.localhost',
  // GitHub Pages serves the site under /<repo>; DOCS_BASE=/dirouter there, unset elsewhere.
  base: process.env.DOCS_BASE || undefined,
  integrations: [
    starlight({
      title: 'DiRouter',
      description: 'Self-hosted LLM gateway and AI platform',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/alirezariahi/dirouter' },
      ],
      lastUpdated: false,
      pagination: true,
    }),
  ],
});
