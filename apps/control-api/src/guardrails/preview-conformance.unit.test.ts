/**
 * The live test runs the gateway's engine (card 23.1): every shared conformance case must reach
 * the verdict the gateway reaches (apps/gateway/src/guardrails.test.ts runs the same file).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertValidPolicyConfig, previewGuardrail } from './guardrails.service.js';

interface ConformanceCase {
  name: string;
  policy: { type: string; action: 'block' | 'redact' | 'flag'; config: Record<string, unknown> };
  text: string;
  expect: { blocked: boolean; hit: boolean; redactedText?: string; valid?: boolean };
}
const cases = (
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../../packages/contracts/src/__fixtures__/guardrails/conformance.json',
      ),
      'utf8',
    ),
  ) as { cases: ConformanceCase[] }
).cases;

describe('live test conformance with the gateway (card 23.1)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = previewGuardrail({ name: 'p', ...c.policy }, c.text);
    expect(result.blocked).toBe(c.expect.blocked);
    expect(result.hit).toBe(c.expect.hit);
    if (c.expect.redactedText !== undefined)
      expect(result.redactedText).toBe(c.expect.redactedText);
    if (c.expect.valid !== undefined) expect(result.valid).toBe(c.expect.valid);
  });

  it('never echoes a whole secret back', () => {
    const key = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123456';
    const result = previewGuardrail({ name: 'p', type: 'secret', action: 'flag' }, `k=${key}`);
    expect(result.matches).toEqual(['sk-proj-…']);
  });

  it('lists the schema problems of a failing answer', () => {
    const result = previewGuardrail(
      {
        name: 'p',
        type: 'json_schema',
        config: {
          schema: { type: 'object', required: ['a'], properties: { b: { type: 'string' } } },
        },
      },
      '{"b": 1}',
    );
    expect(result.schemaErrors).toEqual([
      '$: missing required property "a"',
      '$.b: expected string, got integer',
    ]);
  });
});

describe('json_schema policies are validated when saved (card 23.1)', () => {
  it('need a schema the gateway understands', () => {
    expect(() => {
      assertValidPolicyConfig('json_schema', {});
    }).toThrow(/config.schema/);
    expect(() => {
      assertValidPolicyConfig('json_schema', { schema: { type: 'objekt' } });
    }).toThrow(/unknown type/);
    expect(() => {
      assertValidPolicyConfig('json_schema', { schema: { $ref: '#/defs/x' } });
    }).toThrow(/unsupported keyword "\$ref"/);
    expect(() => {
      assertValidPolicyConfig('json_schema', { schema: { type: 'string', pattern: '(a+)+$' } });
    }).toThrow(/backtrack/);
    expect(() => {
      assertValidPolicyConfig('json_schema', {
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          title: 'Person',
          type: 'object',
          properties: { tags: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 3 } },
          anyOf: [{ required: ['tags'] }, { required: ['name'] }],
        },
      });
    }).not.toThrow();
  });
});

describe('moderation and classifier settings are validated when saved (cards 23.2 and 23.3)', () => {
  it('requires a model and sane limits', () => {
    expect(() => {
      assertValidPolicyConfig('moderation', {});
    }).toThrow(/config.model/);
    expect(() => {
      assertValidPolicyConfig('moderation', { model: 'm', thresholds: { violence: 2 } });
    }).toThrow(/between 0 and 1/);
    expect(() => {
      assertValidPolicyConfig('moderation', { model: 'm', failMode: 'maybe' });
    }).toThrow(/failMode/);
    expect(() => {
      assertValidPolicyConfig('moderation', { model: 'm', timeoutMs: 10 });
    }).toThrow(/timeoutMs/);
    expect(() => {
      assertValidPolicyConfig('prompt_injection', { classifier: { threshold: 0.5 } });
    }).toThrow(/classifier requires a model/);
    assertValidPolicyConfig('moderation', {
      model: 'omni-moderation-latest',
      mode: 'moderations',
      thresholds: { violence: 0.7 },
      timeoutMs: 1500,
      failMode: 'closed',
    });
    assertValidPolicyConfig('prompt_injection', {
      classifier: { model: 'small', failMode: 'open' },
    });
    assertValidPolicyConfig('prompt_injection', {});
  });

  it('the live test says the model call only happens on real traffic', () => {
    const preview = previewGuardrail(
      {
        name: 'moderation',
        type: 'moderation',
        action: 'block',
        config: { model: 'omni-moderation-latest' },
      },
      'anything',
    );
    expect(preview.needsModelCall).toBe(true);
    expect(preview.blocked).toBe(false);
  });
});
