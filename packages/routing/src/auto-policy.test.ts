/** Controls of automatic routing: cost tier, allowed and denied models, lock (card 32.8). */
import type { AutoRoutingPolicyConfig, ModelConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { decideAuto } from './auto.js';
import {
  autoExclusion,
  blendedPricePerMTok,
  chooseReasoningEffort,
  costTierOf,
  effectiveAutoPolicy,
  matchesModel,
} from './auto-policy.js';
import { classifyRequest } from './classifier.js';
import { RouterStats } from './stats.js';

const model = (slug: string, input: string, output = input): ModelConfig => ({
  id: `m-${slug}`,
  organizationId: 'org',
  slug,
  providerId: 'p',
  upstreamModel: slug,
  enabled: true,
  pricing: { inputPerMTok: input, outputPerMTok: output },
  capabilities: {
    streaming: true,
    tools: true,
    vision: true,
    reasoning: true,
    jsonMode: false,
    embeddings: false,
  },
});
const MODELS = [
  model('mini', '0.15', '0.6'),
  model('flash', '0.3', '2.5'),
  model('sonnet', '3', '15'),
  model('opus', '15', '75'),
  model('openai/gpt-x', '1.25', '10'),
];
const policy = (over: Partial<AutoRoutingPolicyConfig>): AutoRoutingPolicyConfig => ({
  organizationId: 'org',
  scope: 'organization',
  scopeId: 'org',
  allowedModels: [],
  deniedModels: [],
  locked: false,
  reasoningEffort: 'auto',
  ...over,
});
const KEY = { id: 'vk', organizationId: 'org' };

describe('cost tiers', () => {
  it('blends three input tokens per output token', () => {
    expect(blendedPricePerMTok(model('x', '1', '5'))).toBe(2);
    expect(MODELS.map((m) => costTierOf(m))).toEqual(['low', 'low', 'medium', 'high', 'medium']);
    expect(costTierOf(model('x', '1', '5'), { lowMaxPerMTok: '2', mediumMaxPerMTok: '3' })).toBe(
      'low',
    );
  });

  it('matches slugs and globs', () => {
    expect(matchesModel(['openai/*'], 'openai/gpt-x')).toBe(true);
    expect(matchesModel(['*-x'], 'openai/gpt-x')).toBe(true);
    expect(matchesModel(['open*gpt*'], 'openai/gpt-x')).toBe(true);
    expect(matchesModel(['open*claude*'], 'openai/gpt-x')).toBe(false);
    expect(matchesModel(['mini'], 'mini-2')).toBe(false);
    expect(matchesModel([], 'mini')).toBe(false);
  });
});

describe('effective policy', () => {
  it('lets an unlocked key replace the organization settings; denied models add up', () => {
    const eff = effectiveAutoPolicy(
      [
        policy({ costTier: 'low', allowedModels: ['mini'], deniedModels: ['flash'] }),
        policy({
          scope: 'key',
          scopeId: 'vk',
          costTier: 'high',
          allowedModels: ['opus'],
          deniedModels: ['sonnet'],
        }),
        policy({ organizationId: 'org-2', scopeId: 'org-2', costTier: 'low' }),
      ],
      KEY,
    );
    expect(eff).toEqual({
      costTier: 'high',
      allowed: [['opus']],
      denied: ['flash', 'sonnet'],
      reasoningEffort: 'auto',
      locked: false,
    });
    expect(
      effectiveAutoPolicy([policy({ organizationId: 'org-2', scopeId: 'org-2' })], KEY),
    ).toBeUndefined();
  });

  it('lets a key only narrow a locked organization policy', () => {
    const eff = effectiveAutoPolicy(
      [
        policy({ costTier: 'medium', allowedModels: ['mini', 'sonnet'], locked: true }),
        policy({ scope: 'key', scopeId: 'vk', costTier: 'high', allowedModels: ['opus', 'mini'] }),
      ],
      KEY,
    );
    expect(eff?.costTier).toBe('medium');
    if (!eff) throw new Error('no policy');
    // Opus is in the key's list but not the organization's: still out.
    expect(autoExclusion(MODELS[3] as ModelConfig, eff)).toContain('not in the allowed set');
    expect(autoExclusion(MODELS[2] as ModelConfig, eff)).toContain('not in the allowed set');
    expect(autoExclusion(MODELS[0] as ModelConfig, eff)).toBeUndefined();
    const cheaper = effectiveAutoPolicy(
      [
        policy({ costTier: 'medium', locked: true }),
        policy({ scope: 'key', scopeId: 'vk', costTier: 'low' }),
      ],
      KEY,
    );
    expect(cheaper?.costTier).toBe('low');
    const off = effectiveAutoPolicy(
      [
        policy({ locked: true, reasoningEffort: 'off' }),
        policy({ scope: 'key', scopeId: 'vk', reasoningEffort: 'auto' }),
      ],
      KEY,
    );
    expect(off?.reasoningEffort).toBe('off');
  });
});

describe('auto routing under a policy', () => {
  const config = {
    enabled: true,
    targets: {
      coding: 'opus',
      reasoning: 'opus',
      chat: 'sonnet',
      summarization: 'flash',
      smart: 'opus',
    },
    pool: ['opus', 'sonnet', 'flash', 'mini'],
    classifierThreshold: 0.5,
  };
  const texts = [
    'Refactor this TypeScript repository and add unit tests',
    'Prove step by step that there are infinitely many primes',
    'Summarize this article in three bullets',
    'hello there',
  ];
  const decide = (
    eff: ReturnType<typeof effectiveAutoPolicy>,
    alias: Parameters<typeof decideAuto>[0],
    text: string,
  ) => {
    const byName = new Map(MODELS.map((m) => [m.slug, m]));
    return decideAuto(
      alias,
      config,
      classifyRequest(
        { system: [], messages: [{ role: 'user', content: [{ type: 'text', text }] }] },
        20,
      ),
      {
        modelsOf: (name) => {
          const m = byName.get(name);
          if (!m) return undefined;
          return eff && autoExclusion(m, eff) ? undefined : [m];
        },
        stats: new RouterStats(),
        estimatedInputTokens: 20,
        maxOutputTokens: 100,
      },
    );
  };

  it('with tier low never picks an expensive model, whatever the request or alias', () => {
    const eff = effectiveAutoPolicy([policy({ costTier: 'low' })], KEY);
    for (const alias of ['auto', 'auto/smart', 'auto/coding', 'auto/fast', 'auto/cheap'] as const)
      for (const text of texts) {
        const d = decide(eff, alias, text);
        if ('error' in d) throw new Error(d.error);
        const chosen = MODELS.find((m) => m.slug === d.target);
        expect(chosen && costTierOf(chosen)).toBe('low');
      }
  });

  it('never picks a model outside the allowed set', () => {
    const eff = effectiveAutoPolicy([policy({ allowedModels: ['sonnet', 'flash'] })], KEY);
    for (const alias of ['auto', 'auto/smart', 'auto/coding', 'auto/fast', 'auto/cheap'] as const)
      for (const text of texts) {
        const d = decide(eff, alias, text);
        if ('error' in d) throw new Error(d.error);
        expect(['sonnet', 'flash']).toContain(d.target);
      }
    const none = effectiveAutoPolicy([policy({ allowedModels: ['nothing-*'] })], KEY);
    expect(decide(none, 'auto', 'hello')).toHaveProperty('error');
  });

  it('chooses a reasoning effort by task, never above the tier', () => {
    expect(chooseReasoningEffort({ taskType: 'reasoning', size: 'small' }, undefined)).toBe('high');
    expect(chooseReasoningEffort({ taskType: 'reasoning', size: 'small' }, 'low')).toBe('low');
    expect(chooseReasoningEffort({ taskType: 'coding', size: 'large' }, 'medium')).toBe('medium');
    expect(chooseReasoningEffort({ taskType: 'coding', size: 'small' }, 'high')).toBe('medium');
    expect(chooseReasoningEffort({ taskType: 'summarization', size: 'small' }, 'high')).toBe('low');
    expect(chooseReasoningEffort({ taskType: 'chat', size: 'small' }, undefined)).toBe('minimal');
  });
});
