/**
 * کلاینت تایپ‌دار API از روی سند OpenAPI control-api (کارت ۷.۱).
 * بازتولید: pnpm --filter @dirouter/control-api openapi:export && pnpm --filter @dirouter/dashboard api:generate
 */
import { defineConfig } from 'orval';

export default defineConfig({
  dirouter: {
    input: './openapi.json',
    output: {
      target: './src/api/generated.ts',
      client: 'react-query',
      mode: 'single',
      override: {
        mutator: { path: './src/lib/api.ts', name: 'orvalFetch' },
        query: { useQuery: true, useMutation: true, signal: true },
      },
    },
  },
});
