/** Request classifier and `auto*` aliases (card 20.4). */
import { performance } from 'node:perf_hooks';

import type { CanonicalRequest, ModelConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { type AutoRoutingConfig, decideAuto } from './auto.js';
import { classifyRequest } from './classifier.js';
import { RouterStats } from './stats.js';

const request = (
  text: string,
  extra: Partial<Pick<CanonicalRequest, 'tools' | 'maxOutputTokens'>> & {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
  } = {},
) => ({
  system: [],
  messages: [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text },
        ...(extra.image ? [{ type: 'image' as const, url: 'https://x.test/a.png' }] : []),
        ...(extra.pdf
          ? [
              {
                type: 'document' as const,
                source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
              },
            ]
          : []),
        ...(extra.audio
          ? [
              {
                type: 'audio' as const,
                source: { kind: 'base64', mediaType: 'audio/wav', data: 'UklGRg==' },
              },
            ]
          : []),
      ],
    },
  ],
  ...(extra.tools ? { tools: extra.tools } : {}),
  ...(extra.maxOutputTokens ? { maxOutputTokens: extra.maxOutputTokens } : {}),
});
const classify = (text: string, extra = {}) =>
  classifyRequest(request(text, extra) as never, Math.ceil(text.length / 4));

describe('classifier', () => {
  it.each([
    ['Fix this: ```ts\nconst a: number = "x"\n```', 'coding'],
    ['Traceback (most recent call last):\n  File "app.py", line 3', 'coding'],
    ['Please refactor the TypeScript repository and add unit tests', 'coding'],
    ['این تابع پایتون باگ دارد، دیباگش کن', 'coding'],
    ['Summarize this article in three bullets', 'summarization'],
    ['لطفاً این متن را خلاصه کن', 'summarization'],
    ['Prove step by step that the square root of 2 is irrational', 'reasoning'],
    ['مسئله را گام به گام حل کن و استدلال کن', 'reasoning'],
    ['Hi! How are you today?', 'chat'],
    ['سلام، حالت چطوره؟', 'chat'],
  ])('%s → %s', (text, type) => {
    const c = classify(text);
    expect(c.taskType).toBe(type);
    expect(c.reasons.length).toBeGreaterThan(0);
  });

  it('notices images, tools and long context', () => {
    expect(classify('what is in this picture?', { image: true }).needs.vision).toBe(true);
    const tools = classify('list the files', {
      tools: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }],
    });
    expect(tools.needs.tools).toBe(true);
    expect(tools.reasons).toContain('tools offered');
    const long = classifyRequest(request('read this') as never, 40_000);
    expect(long.needs.longContext).toBe(true);
    expect(long.size).toBe('large');
  });

  it('costs far less than 2 ms per request, even for a long prompt', () => {
    const long = `${'Lorem ipsum dolor sit amet. '.repeat(4_000)}\nNow refactor the class above.`;
    const samples: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const started = performance.now();
      classify(i % 2 ? long : 'Summarize the meeting notes in three bullets');
      samples.push(performance.now() - started);
    }
    // Single samples catch GC pauses and runner noise (more so under coverage), so the bound is on
    // the average cost per request over batches of 100: the overhead a request actually pays.
    const batches = Array.from(
      { length: samples.length / 100 },
      (_, b) => samples.slice(b * 100, b * 100 + 100).reduce((sum, ms) => sum + ms, 0) / 100,
    );
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? Infinity;
    // eslint-disable-next-line no-console -- the measured overhead is the evidence for the criterion
    console.log(`classifier p50 ${(samples[1_000] ?? 0).toFixed(4)} ms, p99 ${p99.toFixed(4)} ms`);
    expect(Math.max(...batches)).toBeLessThan(2);
  });
});

const model = (
  id: string,
  price: number,
  caps: Partial<ModelConfig['capabilities']> = {},
  contextWindow?: number,
): ModelConfig => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId: 'p',
  upstreamModel: id,
  enabled: true,
  pricing: { inputPerMTok: String(price), outputPerMTok: String(price * 4) },
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    jsonMode: false,
    embeddings: false,
    ...caps,
  },
  ...(contextWindow ? { contextWindow } : {}),
});

describe('auto aliases', () => {
  const models: Record<string, ModelConfig> = {
    coder: model('coder', 3),
    thinker: model('thinker', 10, {}, 200_000),
    mini: model('mini', 0.1, {}, 16_000),
    seer: model('seer', 2, { vision: true }),
    reader: model('reader', 4, { vision: true, documents: true, audioInput: true }),
  };
  const config: AutoRoutingConfig = {
    enabled: true,
    targets: { coding: 'coder', reasoning: 'thinker', chat: 'mini', summarization: 'mini' },
    pool: ['mini', 'seer', 'thinker', 'reader'],
    classifierThreshold: 0.5,
  };
  const stats = new RouterStats();
  const ctx = {
    modelsOf: (name: string) => (models[name] ? [models[name]] : undefined),
    stats,
    estimatedInputTokens: 500,
    maxOutputTokens: 1_000,
  };

  it('auto follows the task type and says why', () => {
    expect(decideAuto('auto', config, classify('```py\nprint(1)\n```'), ctx)).toMatchObject({
      target: 'coder',
      taskType: 'coding',
      source: 'rules',
      reasons: expect.arrayContaining(['code block', 'task type coding → coder']) as unknown,
    });
    expect(decideAuto('auto', config, classify('hello there'), ctx)).toMatchObject({
      target: 'mini',
    });
  });

  it('a target without the needed capability falls back to the cheapest capable pool entry', () => {
    const decision = decideAuto(
      'auto',
      config,
      classify('describe this photo', { image: true }),
      ctx,
    );
    expect(decision).toMatchObject({ target: 'seer' });
    expect('reasons' in decision && decision.reasons.at(-1)).toMatch(/mini lacks images/);
  });

  it('documents and audio need a model marked for them (card 27.2)', () => {
    const pdf = classify('summarize this file', { pdf: true });
    expect(pdf.needs.documents).toBe(true);
    expect(pdf.reasons).toContain('document input');
    expect(decideAuto('auto', config, pdf, ctx)).toMatchObject({ target: 'reader' });
    const audio = classify('transcribe and answer', { audio: true });
    expect(audio.needs.audio).toBe(true);
    expect(decideAuto('auto/cheap', config, audio, ctx)).toMatchObject({ target: 'reader' });
    expect(decideAuto('auto/cheap', { ...config, pool: ['mini', 'seer'] }, audio, ctx)).toEqual({
      error: 'no model in the auto routing pool can serve this request',
    });
  });

  it('auto/cheap and auto/fast choose from the pool', () => {
    expect(decideAuto('auto/cheap', config, classify('hi'), ctx)).toMatchObject({ target: 'mini' });
    // A long request no longer fits mini's 16k context.
    expect(
      decideAuto('auto/cheap', config, classify('hi'), { ...ctx, estimatedInputTokens: 20_000 }),
    ).toMatchObject({ target: 'seer' });
    stats.recordLatency('thinker', 120);
    stats.recordLatency('mini', 900);
    stats.recordLatency('seer', 400);
    expect(decideAuto('auto/fast', config, classify('hi'), ctx)).toMatchObject({
      target: 'thinker',
    });
  });

  it('fixed aliases and errors', () => {
    expect(decideAuto('auto/coding', config, classify('hello'), ctx)).toMatchObject({
      target: 'coder',
      source: 'fixed',
    });
    expect(decideAuto('auto/smart', config, classify('hello'), ctx)).toMatchObject({
      target: 'thinker',
    });
    expect(decideAuto('auto/fast', { ...config, pool: [] }, classify('hi'), ctx)).toEqual({
      error: 'no model in the auto routing pool can serve this request',
    });
    expect(decideAuto('auto/coding', { ...config, targets: {} }, classify('hi'), ctx)).toEqual({
      error: 'no target configured for auto/coding',
    });
  });
});
