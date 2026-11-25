/**
 * Versioned catalog of model prices and capabilities, bundled with each release. It is the baseline:
 * control-api overlays the entries the worker synced from external price sources (card 27.5), so
 * new models and approved price changes arrive without a release, and an install without internet
 * keeps this last good catalog.
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
  /** Provider's announced retirement date, `YYYY-MM-DD` (card 27.5). */
  deprecationDate: z.iso.date().optional(),
  /** `chat`, `embedding`, `image_generation`, … as the source reports it. */
  mode: z.string().max(40).optional(),
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
