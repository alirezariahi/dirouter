/**
 * Card 32.8: controls of automatic routing through Traefik. With the cost tier `low` no `auto*`
 * request reaches an expensive model; a model outside the allowed set is never selected; a locked
 * organization policy cannot be widened by a key; the decision records the tier and its reasons.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published } from '../harness.mjs';

const TEXTS = [
  'Refactor this TypeScript repository and add unit tests',
  'Prove step by step that there are infinitely many primes',
  'Summarize this article in three bullets: the gateway routes requests.',
  'hello there',
];
const ALIASES = ['auto', 'auto/smart', 'auto/coding', 'auto/fast', 'auto/cheap'];

export async function register({ scenario, cleanups, org, createKey }) {
  const suffix = randomUUID().slice(0, 6);

  await scenario(
    '32.8 with the low cost tier no auto request reaches an expensive model, and a model outside the allowed set is never selected',
    async () => {
      const model = async (name, price) => {
        const created = (
          await org(
            'POST',
            'models',
            {
              providerId: 'prv_mock',
              upstreamModel: 'mock-small',
              slug: `s5/${name}-${suffix}`,
              pricing: { inputPerMTok: price, outputPerMTok: price },
              capabilities: { tools: true, reasoning: true },
            },
            201,
          )
        ).body;
        cleanups.push(() => org('DELETE', `models/${created.id}`, undefined, null));
        return created.slug;
      };
      const cheap = await model('cheap', '0.1');
      const mid = await model('mid', '3');
      const big = await model('big', '40');
      const stored = (await org('GET', 'config/settings')).body.stored ?? {};
      cleanups.push(() => published(() => org('PUT', 'config/settings', stored)));
      await published(() =>
        org('PUT', 'config/settings', {
          ...stored,
          autoRouting: {
            enabled: true,
            // Expensive targets everywhere: only the policy keeps auto cheap.
            targets: { coding: big, reasoning: big, chat: big, summarization: mid, smart: big },
            pool: [big, mid, cheap],
          },
        }),
      );
      cleanups.push(() => org('DELETE', 'routing/auto', undefined, null));
      await published(() => org('PUT', 'routing/auto', { costTier: 'low' }, 200));
      const key = await createKey('auto-low');

      const served = [];
      for (const alias of ALIASES)
        for (const content of TEXTS) {
          const res = await chat(key.key, {
            model: alias,
            max_tokens: 16,
            messages: [{ role: 'user', content }],
          });
          assert.equal(res.response.status, 200, res.text);
          served.push(res.response.headers.get('x-dirouter-model'));
        }
      assert.deepEqual([...new Set(served)], [cheap], served.join(','));

      // The allowed set: only the medium model, whatever auto would have liked.
      await published(() =>
        org('PUT', 'routing/auto', { costTier: 'medium', allowedModels: [mid], locked: true }, 200),
      );
      const allowed = [];
      for (const alias of ALIASES)
        for (const content of TEXTS) {
          const res = await chat(key.key, {
            model: alias,
            max_tokens: 16,
            messages: [{ role: 'user', content }],
          });
          assert.equal(res.response.status, 200, res.text);
          allowed.push(res.response.headers.get('x-dirouter-model'));
        }
      assert.deepEqual([...new Set(allowed)], [mid], allowed.join(','));

      // Locked: a key cannot widen the organization's tier or allowed set.
      await org('PUT', `routing/auto/keys/${key.id}`, { costTier: 'high' }, 400);
      await org(
        'PUT',
        `routing/auto/keys/${key.id}`,
        { costTier: 'low', allowedModels: [big] },
        400,
      );
      const overview = (await org('GET', 'routing/auto', undefined, 200)).body;
      const tierOf = (slug) => overview.models.find((m) => m.slug === slug)?.tier;
      assert.deepEqual([tierOf(cheap), tierOf(mid), tierOf(big)], ['low', 'medium', 'high']);
    },
  );
}
