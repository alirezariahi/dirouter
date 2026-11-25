/**
 * Guardrail engine (card 15.1): PII validators, request/response policies, cross-chunk stream
 * redaction that never splits a word, and the per-check overhead budget.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CanonicalRequest, CanonicalResponse, GuardrailPolicy } from '@dirouter/contracts';
import { estimateRequestTokens, roughTokens } from '@dirouter/model-catalog';
import { describe, expect, it } from 'vitest';

import {
  evaluateGuardrails,
  iranNationalIdValid,
  isSafePattern,
  luhnValid,
  policiesFor,
  StreamGuardrailBuffer,
} from './guardrails.js';

const policy = (over: Partial<GuardrailPolicy>): GuardrailPolicy => ({
  id: 'g1',
  organizationId: 'org',
  name: 'policy',
  enabled: true,
  stage: 'both',
  type: 'regex',
  config: {},
  action: 'block',
  ...over,
});
const request = (text: string): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  stream: false,
});
const response = (text: string): CanonicalResponse => ({
  id: 'r',
  model: 'm',
  content: [{ type: 'text', text }],
  finishReason: 'stop',
  created: 0,
});
const userText = (req: CanonicalRequest) => {
  const part = req.messages[0]?.content[0];
  return part?.type === 'text' ? part.text : '';
};

describe('validators', () => {
  it('Luhn accepts real card numbers and rejects other digit runs', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('5500-0000-0000-0004')).toBe(true);
    expect(luhnValid('6037997900000004')).toBe(false);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234')).toBe(false);
  });

  it('validates the Iranian national code check digit', () => {
    expect(iranNationalIdValid('0499370899')).toBe(true);
    expect(iranNationalIdValid('0499370898')).toBe(false);
    expect(iranNationalIdValid('1111111111')).toBe(false);
    expect(iranNationalIdValid('123456789')).toBe(false);
  });
});

describe('evaluateGuardrails', () => {
  it('redacts only checksum-valid card numbers', () => {
    const req = request('card 4111 1111 1111 1111 and order 1234567890123456');
    const result = evaluateGuardrails(
      [policy({ type: 'pii', config: { type: 'credit_card' }, action: 'redact' })],
      { stage: 'request', request: req },
    );
    expect(result.redactions).toBe(1);
    expect(userText(req)).toContain('[REDACTED]');
    expect(userText(req)).toContain('1234567890123456');
    expect(userText(req)).not.toContain('4111');
  });

  it('does not flag a ten-digit number that is not a national code', () => {
    const result = evaluateGuardrails(
      [policy({ type: 'pii', config: { type: 'national_id' }, action: 'block' })],
      { stage: 'request', request: request('tracking number 1234567890') },
    );
    expect(result.blocked).toBeUndefined();
    expect(result.hits).toEqual([]);
    const blocked = evaluateGuardrails(
      [policy({ type: 'pii', config: { type: 'national_id' }, action: 'block' })],
      { stage: 'request', request: request('کد ملی 0499370899') },
    );
    expect(blocked.blocked?.policy.id).toBe('g1');
  });

  it('blocks with the policy message and stops at the first blocking policy', () => {
    const result = evaluateGuardrails(
      [
        policy({ id: 'a', config: { pattern: 'forbidden' }, message: 'nope' }),
        policy({ id: 'b', config: { pattern: 'forbidden' }, action: 'flag' }),
      ],
      { stage: 'request', request: request('this is forbidden') },
    );
    expect(result.blocked?.message).toBe('nope');
    expect(result.hits.map((h) => h.policyId)).toEqual(['a']);
  });

  it('respects the stage and the enabled flag', () => {
    const policies = [
      policy({ id: 'req', stage: 'request', config: { pattern: 'x' }, action: 'flag' }),
      policy({ id: 'off', enabled: false, config: { pattern: 'x' } }),
    ];
    expect(
      evaluateGuardrails(policies, { stage: 'response', response: response('x') }).hits,
    ).toEqual([]);
    expect(
      evaluateGuardrails(policies, { stage: 'request', request: request('x') }).hits.map(
        (h) => h.policyId,
      ),
    ).toEqual(['req']);
  });

  it('an invalid regular expression is ignored instead of failing the request', () => {
    const result = evaluateGuardrails([policy({ config: { pattern: '([unclosed' } })], {
      stage: 'request',
      request: request('anything'),
    });
    expect(result.blocked).toBeUndefined();
  });
});

describe('policiesFor', () => {
  it('applies organization-wide policies and only the matching project or key scope', () => {
    const key = { id: 'vk1', organizationId: 'org', projectId: 'p1' };
    const all = [
      policy({ id: 'org-wide' }),
      policy({ id: 'this-project', projectId: 'p1' }),
      policy({ id: 'other-project', projectId: 'p2' }),
      policy({ id: 'this-key', virtualKeyId: 'vk1' }),
      policy({ id: 'other-key', virtualKeyId: 'vk2' }),
      policy({ id: 'other-org', organizationId: 'elsewhere' }),
    ];
    expect(policiesFor(all, key).map((p) => p.id)).toEqual([
      'org-wide',
      'this-project',
      'this-key',
    ]);
  });
});

describe('StreamGuardrailBuffer', () => {
  const email = policy({
    type: 'pii',
    config: { type: 'email' },
    action: 'redact',
    stage: 'response',
  });
  const stream = (chunks: string[], policies: GuardrailPolicy[], window?: number) => {
    const buffer = new StreamGuardrailBuffer(policies, window);
    const emitted: string[] = [];
    for (const chunk of chunks) {
      const out = buffer.push(chunk);
      if (out.blocked) return { text: emitted.join(''), emitted, blocked: out.blocked };
      if (out.text) emitted.push(out.text);
    }
    const tail = buffer.flush();
    if (tail) emitted.push(tail);
    return { text: emitted.join(''), emitted, blocked: undefined };
  };

  it('passes text through untouched when no response policy is active', () => {
    const buffer = new StreamGuardrailBuffer([
      policy({ stage: 'request', config: { pattern: 'x' } }),
    ]);
    expect(buffer.active).toBe(false);
    expect(buffer.push('hello')).toEqual({ text: 'hello' });
  });

  it('redacts a match that is split across chunks', () => {
    const out = stream(['contact me at john.d', 'oe@exam', 'ple.com please'], [email]);
    expect(out.text).toBe('contact me at [REDACTED] please');
  });

  it('never emits a partial word, for any chunking of a long text', () => {
    const sentence = 'Please write to alice.wonderland@example.com or bob@example.org today. ';
    const full = sentence.repeat(12);
    const expected = full.replace(/\S+@\S+\.(com|org)/g, '[REDACTED]');
    const words = new Set(expected.split(/\s+/).filter(Boolean));
    for (const size of [1, 3, 7, 16, 50]) {
      const chunks: string[] = [];
      for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
      const out = stream(chunks, [email], 64);
      expect(out.text).toBe(expected);
      // Every emitted piece ends on a whitespace boundary (except the final flush), so no piece
      // ends in the middle of a word and no address fragment ever leaves unredacted.
      for (const piece of out.emitted.slice(0, -1)) expect(/\s$/.test(piece)).toBe(true);
      for (const piece of out.emitted)
        for (const word of piece.split(/\s+/).filter(Boolean)) expect(words.has(word)).toBe(true);
      expect(out.text).not.toContain('@');
    }
  });

  it('holds text back and then releases it, bounded by the window', () => {
    const buffer = new StreamGuardrailBuffer([email], 64);
    expect(buffer.push('short text ').text).toBe('');
    const released = buffer.push('word '.repeat(40)).text;
    expect(released.length).toBeGreaterThan(0);
    expect(buffer.flush().length).toBeLessThanOrEqual(64 + 5);
  });

  it('blocks the stream when a blocking policy matches across chunks', () => {
    const block = policy({
      config: { pattern: 'top secret' },
      stage: 'response',
      message: 'blocked!',
    });
    const out = stream(['this is top se', 'cret material'], [block]);
    expect(out.blocked).toBe('blocked!');
    expect(out.text).toBe('');
  });
});

describe('overhead', () => {
  it('a regex check on a 4 KB prompt costs well under 1 ms', () => {
    const policies = [
      policy({
        config: { pattern: '\\\\b(?:password|secret)\\\\s*[:=]\\\\s*\\\\S+' },
        action: 'flag',
      }),
    ];
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(90);
    const input = { stage: 'request' as const, request: request(text) };
    for (let i = 0; i < 200; i++) evaluateGuardrails(policies, input); // warm-up (JIT, regex cache)
    const rounds = 2_000;
    const started = performance.now();
    for (let i = 0; i < rounds; i++) evaluateGuardrails(policies, input);
    const perCheckMs = (performance.now() - started) / rounds;
    // eslint-disable-next-line no-console -- the measured number is the evidence for the criterion
    console.log(
      `guardrail regex check: ${perCheckMs.toFixed(4)} ms on ${String(text.length)} chars`,
    );
    expect(perCheckMs).toBeLessThan(1);
  });
});

describe('pattern safety and tool output', () => {
  it('rejects patterns prone to catastrophic backtracking and keeps ordinary ones', () => {
    for (const bad of ['(a+)+$', '(.*)*x', '(a|aa)+$', '(\\d+)*', 'x'.repeat(600)])
      expect(isSafePattern(bad)).toBe(false);
    for (const good of ['secret-\\d{4}', '(?:foo|bar)baz', 'api[_-]?key\\s*[:=]', '(abc)+'])
      expect(isSafePattern(good)).toBe(true);
  });

  it('an unsafe saved pattern is ignored instead of stalling the request path', () => {
    const started = Date.now();
    const result = evaluateGuardrails([policy({ config: { pattern: '(a+)+$' } })], {
      stage: 'request',
      request: request(`${'a'.repeat(40)}!`),
    });
    expect(result.blocked).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('checks tool results like user text', () => {
    const req: CanonicalRequest = {
      inboundApi: 'openai.chat',
      model: 'm',
      system: [],
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'c1',
              content: [{ type: 'text', text: 'token secret-1234 found' }],
            },
          ],
        },
      ],
      stream: false,
    };
    const result = evaluateGuardrails([policy({ config: { pattern: 'secret-\\d{4}' } })], {
      stage: 'request',
      request: req,
    });
    expect(result.blocked).toBeDefined();
  });
});

interface ConformanceCase {
  name: string;
  policy: Pick<GuardrailPolicy, 'type' | 'action' | 'config'>;
  text: string;
  expect: { blocked: boolean; hit: boolean; redactedText?: string; valid?: boolean };
}
/** Shared with the panel's live test (card 23.1): both must reach the same verdict. */
const conformance = (
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../packages/contracts/src/__fixtures__/guardrails/conformance.json',
      ),
      'utf8',
    ),
  ) as { cases: ConformanceCase[] }
).cases;

/** Streams `text` through the buffer in chunks of `size` characters. */
function streamThrough(policies: GuardrailPolicy[], text: string, size = 7) {
  const buffer = new StreamGuardrailBuffer(policies);
  let out = '';
  let blocked: string | undefined;
  for (let i = 0; i < text.length && !blocked; i += size) {
    const step = buffer.push(text.slice(i, i + size));
    out += step.text;
    blocked = step.blocked;
  }
  if (!blocked) {
    const end = buffer.finish(true);
    out += end.text;
    blocked = end.blocked;
  }
  return { out, blocked, buffer };
}

describe('conformance with the panel live test (card 23.1)', () => {
  it.each(conformance.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const p = policy({ ...c.policy, stage: 'both' });
    if (c.policy.type === 'json_schema') {
      // Only answers have a shape: the request side never triggers it.
      expect(evaluateGuardrails([p], { stage: 'request', request: request(c.text) }).hits).toEqual(
        [],
      );
      const res = response(c.text);
      const result = evaluateGuardrails([p], { stage: 'response', response: res });
      expect(result.blocked !== undefined).toBe(c.expect.blocked);
      expect(result.hits.length > 0).toBe(c.expect.hit);
      if (c.expect.valid === false) expect(result.schemaErrors?.length).toBeGreaterThan(0);
      const streamed = streamThrough([p], c.text);
      expect(streamed.blocked !== undefined).toBe(c.expect.blocked);
      expect(streamed.buffer.hits.length > 0).toBe(c.expect.hit);
      // A blocked answer never reaches the client, not even partly.
      if (c.expect.blocked) expect(streamed.out).toBe('');
      else expect(streamed.out).toBe(c.text);
      return;
    }
    const req = request(c.text);
    const result = evaluateGuardrails([p], {
      stage: 'request',
      request: req,
      estimatedInputTokens: estimateRequestTokens(req, roughTokens),
    });
    expect(result.blocked !== undefined).toBe(c.expect.blocked);
    expect(result.hits.length > 0).toBe(c.expect.hit);
    if (c.expect.redactedText !== undefined) expect(userText(req)).toBe(c.expect.redactedText);
    if (c.policy.type === 'max_input_tokens') return;
    // The same policy on the answer, JSON and stream.
    const res = response(c.text);
    const onResponse = evaluateGuardrails([p], { stage: 'response', response: res });
    expect(onResponse.blocked !== undefined).toBe(c.expect.blocked);
    const streamed = streamThrough([p], c.text);
    expect(streamed.blocked !== undefined).toBe(c.expect.blocked);
    if (!c.expect.blocked) expect(streamed.out).toBe(c.expect.redactedText ?? c.text);
  });
});

describe('secret and json_schema in streams (card 23.1)', () => {
  const key = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123456';
  it('blocks a key split across many chunks before any part of it is sent', () => {
    const text = `Here is the key you asked for: ${key} and nothing else.`;
    const { out, blocked } = streamThrough([policy({ type: 'secret', action: 'block' })], text, 3);
    expect(blocked).toMatch(/blocked/);
    expect(out).not.toContain('sk-proj');
  });

  it('holds a PEM block until its END line, so no line of a long key leaks', () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `MIIE${String(i).padStart(4, '0')}abcdefghijklmnopqrstuvwxyz0123456789ABCD`,
    ).join('\n');
    const text = `start\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter the key comes more text`;
    const { out, blocked } = streamThrough(
      [policy({ type: 'secret', action: 'redact' })],
      text,
      11,
    );
    expect(blocked).toBeUndefined();
    expect(out).not.toContain('MIIE');
    expect(out).toBe('start\n[REDACTED]\nafter the key comes more text');
  });

  it('redacts an unterminated key at the end of the stream', () => {
    const text = 'x\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabcdefghijklmnop';
    const { out } = streamThrough([policy({ type: 'secret', action: 'redact' })], text, 5);
    expect(out).not.toContain('MHcC');
  });

  it('json_schema block holds the answer; flag lets it flow and records the verdict at the end', () => {
    const schema = { type: 'object', required: ['ok'] };
    const blocking = new StreamGuardrailBuffer([
      policy({ type: 'json_schema', action: 'block', config: { schema } }),
    ]);
    expect(blocking.push('{"ok"').text).toBe('');
    // A non-text event before any text (role, block start) gives no verdict yet.
    expect(
      new StreamGuardrailBuffer([policy({ type: 'json_schema', config: { schema } })]).finish(),
    ).toEqual({ text: '' });
    expect(blocking.push(': true}').text).toBe('');
    expect(blocking.finish()).toEqual({ text: '{"ok": true}' });

    const flagging = new StreamGuardrailBuffer([
      policy({ type: 'json_schema', action: 'flag', config: { schema } }),
    ]);
    expect(flagging.push('{"nope": 1}').text).toBe('{"nope": 1}');
    expect(flagging.finish()).toEqual({ text: '' });
    expect(flagging.finish(true)).toEqual({ text: '' });
    expect(flagging.hits).toEqual([
      expect.objectContaining({ type: 'json_schema', action: 'flag' }),
    ]);
  });

  it('an empty answer fails a json_schema policy at the end of the stream', () => {
    const buffer = new StreamGuardrailBuffer([
      policy({ type: 'json_schema', action: 'block', config: { schema: { type: 'object' } } }),
    ]);
    expect(buffer.finish(true).blocked).toMatch(/schema/);
  });
});

describe('unknown policy types (card 23.1)', () => {
  it('are skipped and reported instead of silently ignored', () => {
    const unknown = policy({ id: 'future', type: 'toxicity_v9', action: 'block' });
    const result = evaluateGuardrails(
      [unknown, policy({ id: 'known', config: { pattern: 'x' }, action: 'flag' })],
      {
        stage: 'request',
        request: request('x'),
      },
    );
    expect(result.blocked).toBeUndefined();
    expect(result.unknown.map((p) => p.id)).toEqual(['future']);
    expect(result.hits.map((h) => h.policyId)).toEqual(['known']);
    const { buffer } = streamThrough([unknown], 'some answer text that is long enough');
    expect(buffer.unknown.map((p) => p.id)).toEqual(['future']);
  });
});

describe('whole-answer hold (review fix)', () => {
  it('blocks an answer too long to judge instead of releasing it unchecked', () => {
    const buffer = new StreamGuardrailBuffer([
      policy({ type: 'json_schema', action: 'block', config: { schema: { type: 'object' } } }),
    ]);
    expect(buffer.holdsWholeAnswer).toBe(true);
    const big = 'x'.repeat(600_000);
    expect(buffer.push(big).blocked).toBeUndefined();
    expect(buffer.push(big).blocked).toMatch(/too long/);
    expect(buffer.judgeWhole('y'.repeat(1_100_000)).blocked).toMatch(/too long/);
  });

  it('gives a flag verdict only at the end of the stream, on the whole answer', () => {
    const buffer = new StreamGuardrailBuffer([
      policy({ type: 'json_schema', action: 'flag', config: { schema: { type: 'object' } } }),
    ]);
    expect(buffer.holdsWholeAnswer).toBe(false);
    buffer.push('{"a": ');
    buffer.finish();
    expect(buffer.hits).toEqual([]);
    buffer.push('1}');
    buffer.finish(true);
    expect(buffer.hits).toEqual([]);
  });
});
