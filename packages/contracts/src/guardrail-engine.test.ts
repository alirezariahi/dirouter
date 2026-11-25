/** JSON Schema subset and secret detection of the shared guardrail engine (card 23.1). */
import { describe, expect, it } from 'vitest';

import {
  evaluateGuardrails,
  jsonSchemaProblem,
  parseJsonAnswer,
  pendingPrivateKeyStart,
  SECRET_PATTERNS,
  validateJsonSchema,
} from './guardrail-engine.js';

describe('validateJsonSchema', () => {
  const schema = {
    type: 'object',
    required: ['id', 'kind'],
    properties: {
      id: { type: 'integer', exclusiveMinimum: 0 },
      kind: { const: 'order' },
      note: { type: ['string', 'null'], maxLength: 3 },
      tags: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^[a-z]+$' } },
      price: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
    },
    additionalProperties: false,
  };

  it('accepts a conforming value', () => {
    expect(
      validateJsonSchema({ id: 3, kind: 'order', note: 'ab', tags: ['x'], price: '1.5' }, schema),
    ).toEqual([]);
    expect(validateJsonSchema({ id: 1, kind: 'order', note: null }, schema)).toEqual([]);
  });

  it('reports each problem with its path', () => {
    expect(
      validateJsonSchema(
        { id: 0, kind: 'refund', note: 'abcd', tags: ['A', 'b', 'c'], extra: 1 },
        schema,
      ),
    ).toEqual([
      '$.id: must be greater than 0',
      '$.kind: must equal the constant value',
      '$.note: longer than 3 characters',
      '$.tags: more than 2 items',
      '$.tags[0]: does not match the pattern',
      '$.extra: no value is allowed here',
    ]);
  });

  it('counts code points for string length and treats integers as numbers', () => {
    expect(validateJsonSchema('😀😀', { type: 'string', maxLength: 2 })).toEqual([]);
    expect(validateJsonSchema(2, { type: 'number' })).toEqual([]);
    expect(validateJsonSchema(2.5, { type: 'integer' })).toEqual([
      '$: expected integer, got number',
    ]);
    expect(validateJsonSchema(1, { oneOf: [{ type: 'number' }, { type: 'integer' }] })).toEqual([
      '$: must match exactly one of oneOf',
    ]);
    expect(validateJsonSchema(true, { anyOf: [{ type: 'string' }, { enum: [1] }] })).toEqual([
      '$: matches none of anyOf',
    ]);
  });
});

describe('jsonSchemaProblem', () => {
  it('accepts annotations and refuses what the validator cannot enforce', () => {
    expect(
      jsonSchemaProblem({ title: 't', description: 'd', format: 'email', type: 'string' }),
    ).toBe(undefined);
    expect(jsonSchemaProblem({ properties: { a: { if: {} } } })).toBe(
      '#/properties/a: unsupported keyword "if"',
    );
    expect(jsonSchemaProblem({ minLength: -1 })).toMatch(/non-negative integer/);
    expect(jsonSchemaProblem('object')).toMatch(/must be an object or a boolean/);
  });
});

describe('parseJsonAnswer', () => {
  it('accepts bare JSON and one Markdown fence', () => {
    expect(parseJsonAnswer(' {"a":1} ')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonAnswer('```\n[1]\n```')).toEqual({ ok: true, value: [1] });
    expect(parseJsonAnswer('Here: {"a":1}')).toEqual({ ok: false });
  });
});

describe('secrets', () => {
  const found = (text: string) =>
    SECRET_PATTERNS.filter(({ regex }) => {
      regex.lastIndex = 0;
      return regex.test(text);
    }).map((p) => p.name);

  it('recognizes common credential formats', () => {
    expect(found('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toEqual(['google_api_key']);
    expect(found('xoxb-1234567890-abcdef')).toEqual(['slack_token']);
    expect(
      found(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ),
    ).toEqual(['jwt']);
    expect(found('the sk-1 model and a skeleton key')).toEqual([]);
  });

  it('finds a PEM block that is still open', () => {
    expect(pendingPrivateKeyStart('a -----BEGIN PRIVATE KEY-----\nMII')).toBe(2);
    expect(
      pendingPrivateKeyStart('-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----'),
    ).toBe(-1);
    expect(pendingPrivateKeyStart('no key')).toBe(-1);
  });
});

describe('model-call policies without a verdict (review fix)', () => {
  const moderation = (failMode: 'open' | 'closed') =>
    ({
      id: 'm',
      organizationId: 'o',
      name: 'm',
      enabled: true,
      stage: 'response',
      type: 'moderation',
      config: { model: 'mod', failMode },
      action: 'block',
    }) as const;
  const response = () => ({
    id: 'r',
    model: 'x',
    content: [{ type: 'text' as const, text: 'hello' }],
    finishReason: 'stop' as const,
    created: 0,
  });

  it('counts as unavailable in traffic, so fail-closed blocks', () => {
    const traffic = { stage: 'response' as const, response: response(), external: new Map() };
    expect(evaluateGuardrails([moderation('closed')], traffic).blocked).toBeDefined();
    expect(evaluateGuardrails([moderation('open')], traffic).blocked).toBeUndefined();
  });

  it('is skipped in the live test, which makes no model calls', () => {
    expect(
      evaluateGuardrails([moderation('closed')], { stage: 'response', response: response() })
        .blocked,
    ).toBeUndefined();
  });
});
