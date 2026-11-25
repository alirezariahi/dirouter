/**
 * Prompt-injection detection measured on a labelled set (card 23.3): 50 attacks and 50 benign
 * texts in English and Persian. The rates are printed so a change to the patterns shows its effect.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { evaluateGuardrails } from './guardrail-engine.js';
import type { GuardrailPolicy } from './guardrails.js';

interface Sample {
  text: string;
  injection: boolean;
  lang: 'en' | 'fa';
}

const { cases } = JSON.parse(
  readFileSync(new URL('./__fixtures__/guardrails/prompt-injection.json', import.meta.url), 'utf8'),
) as { cases: Sample[] };

const policy: GuardrailPolicy = {
  id: 'pi',
  organizationId: 'org',
  name: 'injection',
  enabled: true,
  stage: 'request',
  type: 'prompt_injection',
  config: {},
  action: 'block',
};

const detected = (text: string) =>
  evaluateGuardrails([policy], {
    stage: 'request',
    request: {
      inboundApi: 'openai.chat',
      model: 'm',
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      stream: false,
    },
  }).blocked !== undefined;

describe('prompt-injection patterns on the labelled set', () => {
  it('has at least 50 attacks and 50 benign samples in both languages', () => {
    const attacks = cases.filter((c) => c.injection);
    const benign = cases.filter((c) => !c.injection);
    expect(attacks.length).toBeGreaterThanOrEqual(50);
    expect(benign.length).toBeGreaterThanOrEqual(50);
    for (const lang of ['en', 'fa'] as const) {
      expect(attacks.some((c) => c.lang === lang)).toBe(true);
      expect(benign.some((c) => c.lang === lang)).toBe(true);
    }
  });

  it('reports detection and false-positive rates per language', () => {
    const rows = (['en', 'fa'] as const).map((lang) => {
      const attacks = cases.filter((c) => c.injection && c.lang === lang);
      const benign = cases.filter((c) => !c.injection && c.lang === lang);
      const missed = attacks.filter((c) => !detected(c.text)).map((c) => c.text);
      const falsePositives = benign.filter((c) => detected(c.text)).map((c) => c.text);
      return {
        lang,
        detection: (attacks.length - missed.length) / attacks.length,
        falsePositive: falsePositives.length / benign.length,
        missed,
        falsePositives,
      };
    });
    // eslint-disable-next-line no-console
    console.info(
      rows
        .map(
          (r) =>
            `${r.lang}: detection ${(r.detection * 100).toFixed(0)}%, false positives ${(r.falsePositive * 100).toFixed(0)}%` +
            (r.missed.length ? `\n  missed: ${r.missed.join(' | ')}` : '') +
            (r.falsePositives.length ? `\n  false positives: ${r.falsePositives.join(' | ')}` : ''),
        )
        .join('\n'),
    );
    for (const r of rows) {
      expect(r.detection).toBeGreaterThanOrEqual(0.9);
      expect(r.falsePositive).toBeLessThanOrEqual(0.04);
    }
  });
});
