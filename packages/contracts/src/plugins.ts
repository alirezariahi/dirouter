/**
 * Provider plugins (card 21.2): a folder under PLUGINS_DIR with a `plugin.json` manifest and one
 * JavaScript file. Plugins translate between DiRouter's OpenAI-format chat request and a
 * provider's own API; the gateway does every network call itself.
 */
import { z } from 'zod';

export const PluginManifest = z.object({
  /** Folder name and the value of the provider's `options.plugin`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'lowercase letters, digits and -'),
  version: z.string().min(1).max(32),
  displayName: z.string().min(1).max(100),
  description: z.string().max(1_000).optional(),
  /** Script inside the plugin folder that assigns `module.exports`. */
  entry: z
    .string()
    .regex(/^[\w-]+(\/[\w-]+)*\.js$/, 'a relative .js path inside the plugin')
    .default('index.js'),
  /** Hosts the plugin may send requests to, besides the provider's own base URL host. */
  hosts: z.array(z.string().min(1)).max(20).default([]),
  defaultBaseUrl: z.url().optional(),
  /**
   * Terms-of-service risk: a provider using this plugin cannot be created or used until an
   * operator explicitly accepts this text.
   */
  termsWarning: z
    .object({ text: z.string().min(1).max(2_000), url: z.url().optional() })
    .optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
