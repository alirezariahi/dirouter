// Documentation site (card 22.5): English at the root, Persian (RTL) under /fa.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.DOCS_SITE_URL ?? 'https://docs.localhost',
  integrations: [
    starlight({
      title: 'DiRouter',
      description: 'Self-hosted LLM gateway and AI platform',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        fa: { label: 'فارسی', lang: 'fa', dir: 'rtl' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/alirezariahi/dirouter' },
      ],
      lastUpdated: false,
      pagination: true,
    }),
  ],
});
