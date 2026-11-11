/**
 * Typed API client generated from the control-api OpenAPI document (card 7.1).
 * Regenerate: pnpm --filter @dirouter/control-api openapi:export && pnpm --filter @dirouter/dashboard api:generate
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
