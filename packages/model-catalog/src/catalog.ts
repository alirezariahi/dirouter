/**
 * Versioned catalog of model prices and capabilities. Updating prices only means editing catalog.json
 * (no migration); control-api uses it when adding a model or via "catalog sync"
 * to read it.
 */
import { ModelCapabilities, ModelPricing } from '@dirouter/contracts';
import { z } from 'zod';

import raw from './catalog.json' with { type: 'json' };

export const CatalogEntry = z.object({
  key: z.string(),
  provider: z.string(),
  upstreamModel: z.string(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  pricing: ModelPricing,
  capabilities: ModelCapabilities,
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const Catalog = z.object({
  version: z.string(),
  currency: z.literal('USD'),
  unit: z.string(),
  models: z.array(CatalogEntry),
});
export type Catalog = z.infer<typeof Catalog>;

export const catalog: Catalog = Catalog.parse(raw);
export const MODEL_CATALOG_VERSION = catalog.version;

const byKey = new Map(catalog.models.map((m) => [m.key, m]));
const byUpstream = new Map(catalog.models.map((m) => [`${m.provider}:${m.upstreamModel}`, m]));

export function findCatalogEntry(key: string): CatalogEntry | undefined {
  return byKey.get(key);
}

/** Search by provider type/preset and upstream model name (for model discovery). */
export function findByUpstream(provider: string, upstreamModel: string): CatalogEntry | undefined {
  return byUpstream.get(`${provider}:${upstreamModel}`);
}
