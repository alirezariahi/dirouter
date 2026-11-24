import { describe, expect, it } from 'vitest';

import { redactForStorage } from './guardrail-engine.js';
import type { GuardrailPolicy } from './guardrails.js';
import { bodyCaptureLevel, type BodyCaptureRule, RequestBodyRecord } from './request-body.js';
import { ConfigSnapshot } from './config-snapshot.js';

const key = { id: 'vk_1', organizationId: 'org_1', projectId: 'prj_1' };
const rule = (
  scope: BodyCaptureRule['scope'],
  scopeId: string,
  level: BodyCaptureRule['level'],
  organizationId = 'org_1',
): BodyCaptureRule => ({ organizationId, scope, scopeId, level });

describe('bodyCaptureLevel', () => {
  it('is off by default', () => {
    expect(bodyCaptureLevel([], key, {})).toBe('none');
    expect(bodyCaptureLevel([], key, { logBodies: false })).toBe('none');
  });

  it('takes the most specific level: key, then project, then organization, then the default', () => {
    const rules = [
      rule('organization', 'org_1', 'metadata'),
      rule('project', 'prj_1', 'full'),
      rule('key', 'vk_1', 'none'),
    ];
    expect(bodyCaptureLevel(rules, key, {})).toBe('none');
    expect(bodyCaptureLevel(rules.slice(0, 2), key, {})).toBe('full');
    expect(bodyCaptureLevel(rules.slice(0, 1), key, {})).toBe('metadata');
    expect(bodyCaptureLevel([], key, { bodyCapture: { defaultLevel: 'metadata' } })).toBe(
      'metadata',
    );
  });

  it('keeps the legacy logBodies switch as the instance default', () => {
    expect(bodyCaptureLevel([], key, { logBodies: true })).toBe('full');
    expect(
      bodyCaptureLevel([], key, { logBodies: true, bodyCapture: { defaultLevel: 'none' } }),
    ).toBe('none');
  });

  it("never applies another organization's rules", () => {
    const rules = [
      rule('organization', 'org_1', 'full', 'org_2'),
      rule('project', 'prj_1', 'full', 'org_2'),
      rule('key', 'vk_1', 'full', 'org_2'),
    ];
    expect(bodyCaptureLevel(rules, key, {})).toBe('none');
  });
});

describe('redactForStorage', () => {
  const policy = (over: Partial<GuardrailPolicy>): GuardrailPolicy => ({
    id: 'g1',
    organizationId: 'org_1',
    name: 'p',
    enabled: true,
    stage: 'both',
    type: 'pii',
    config: { type: 'email' },
    action: 'redact',
    ...over,
  });

  it('masks what redact policies match in every string of the body', () => {
    const body = {
      model: 'gpt',
      messages: [
        { role: 'user', content: 'mail me at jane@example.com' },
        { role: 'user', content: [{ type: 'text', text: 'or bob@example.org' }] },
      ],
    };
    const out = redactForStorage([policy({})], body, 'request');
    expect(out.redactions).toBe(2);
    expect(JSON.stringify(out.value)).not.toContain('@example');
    expect(JSON.stringify(out.value)).toContain('[REDACTED]');
    // The input is left alone.
    expect(body.messages[0]?.content).toBe('mail me at jane@example.com');
  });

  it('ignores block and flag policies, disabled ones and the other stage', () => {
    const text = { content: 'jane@example.com' };
    for (const p of [
      policy({ action: 'flag' }),
      policy({ action: 'block' }),
      policy({ enabled: false }),
      policy({ stage: 'response' }),
    ])
      expect(redactForStorage([p], text, 'request').value).toEqual(text);
  });

  it('always masks credentials, even without a policy', () => {
    const out = redactForStorage(
      [],
      { content: 'key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123456' },
      'request',
    );
    expect(out.redactions).toBe(1);
    expect(out.value).toEqual({ content: 'key [REDACTED]' });
  });
});

describe('RequestBodyRecord', () => {
  it('accepts a metadata-only record without text', () => {
    const parsed = RequestBodyRecord.parse({
      requestId: 'req_1',
      createdAt: new Date().toISOString(),
      organizationId: 'org_1',
      projectId: 'prj_1',
      apiKeyId: 'vk_1',
      inboundApi: 'openai.chat',
      level: 'metadata',
      metadata: {
        parameters: ['temperature'],
        messages: 1,
        roles: { user: 1 },
        tools: [],
        requestBytes: 10,
        responseBytes: 20,
      },
    });
    expect(parsed.request).toBeUndefined();
    expect(parsed.requestTruncated).toBe(false);
  });
});

describe('ConfigSnapshot', () => {
  it('defaults to no body capture rules', () => {
    const snapshot = ConfigSnapshot.parse({
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [],
      models: [],
      combos: [],
      aliases: [],
      virtualKeys: [],
      settings: {},
    });
    expect(snapshot.bodyCapture).toEqual([]);
    expect(snapshot.settings.logBodies).toBe(false);
  });
});
