/**
 * Discovers and loads provider plugins (card 21.2). Plugins are off by default: only the names
 * listed in PLUGINS_ENABLED are read from PLUGINS_DIR. Every plugin loads on its own, so a broken
 * one is reported and skipped while the rest (and the gateway) keep working.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { PluginManifest } from '@dirouter/contracts';

import { clearPluginAdapters, registerPluginAdapter } from '../adapters.js';
import { PluginAdapter } from './adapter.js';
import { PluginSandbox } from './sandbox.js';

const MAX_SOURCE_BYTES = 1024 * 1024;

export interface PluginStatus {
  name: string;
  manifest?: PluginManifest;
  status: 'available' | 'loaded' | 'failed';
  error?: string;
}

/** `PLUGINS_ENABLED`: comma- or space-separated plugin names. */
export function enabledPlugins(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/[\s,]+/).filter(Boolean))];
}

async function readManifest(dir: string, name: string): Promise<PluginManifest> {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) throw new Error('invalid plugin name');
  const raw = JSON.parse(await readFile(join(dir, name, 'plugin.json'), 'utf8')) as unknown;
  const parsed = PluginManifest.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `invalid plugin.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  if (parsed.data.name !== name)
    throw new Error(`plugin.json names '${parsed.data.name}', folder is '${name}'`);
  return parsed.data;
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Manifests only, no code is run: what the control-api shows to operators. */
export async function readPlugins(dir: string, enabled: string[]): Promise<PluginStatus[]> {
  return Promise.all(
    enabled.map(async (name): Promise<PluginStatus> => {
      try {
        return { name, manifest: await readManifest(dir, name), status: 'available' };
      } catch (error) {
        return { name, status: 'failed', error: failure(error) };
      }
    }),
  );
}

/** Loads the enabled plugins into the adapter registry; never throws. */
export async function loadPlugins(
  dir: string,
  enabled: string[],
  options: { timeoutMs?: number } = {},
): Promise<PluginStatus[]> {
  clearPluginAdapters();
  const root = resolve(dir);
  return Promise.all(
    enabled.map(async (name): Promise<PluginStatus> => {
      let manifest: PluginManifest | undefined;
      try {
        manifest = await readManifest(root, name);
        const pluginDir = join(root, name);
        const entry = resolve(pluginDir, manifest.entry);
        if (relative(pluginDir, entry).startsWith(`..${sep}`))
          throw new Error('entry must stay inside the plugin folder');
        if ((await stat(entry)).size > MAX_SOURCE_BYTES)
          throw new Error('entry is larger than 1 MB');
        const sandbox = new PluginSandbox(
          await readFile(entry, 'utf8'),
          `${name}/${manifest.entry}`,
          options.timeoutMs,
        );
        if (!sandbox.has('buildRequest')) throw new Error('plugin does not export buildRequest');
        registerPluginAdapter(name, new PluginAdapter(manifest, sandbox));
        return { name, manifest, status: 'loaded' };
      } catch (error) {
        return { name, ...(manifest ? { manifest } : {}), status: 'failed', error: failure(error) };
      }
    }),
  );
}
