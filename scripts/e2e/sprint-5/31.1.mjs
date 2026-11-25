/**
 * Card 31.1: JSON and tool-call repair, through Traefik against the mock provider. The mock
 * answers an unpaired tool history with the providers' own 400, and answers with broken JSON when
 * its key says so (`text_b64`).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, urls, waitFor } from '../harness.mjs';

const BROKEN = '```json\n{"city": "Tehran", "temp": 21,}\n```';

export async function register({ scenario, cleanups, org, createKey }) {
  /** A mock-backed provider and one model on it; both removed at the end. */
  async function mockModel(name, type, upstreamModel, secret) {
    const tag = `${name}-${randomUUID().slice(0, 6)}`;
    const provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-311-${tag}`,
            slug: `s5-311-${tag}`,
            type,
            baseUrl:
              type === 'anthropic' ? 'http://mock-provider:8090' : 'http://mock-provider:8090/v1',
            credentials: [{ name: 'k', secret }],
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
    const model = (
      await published(() =>
        org(
          'POST',
          'models',
          {
            providerId: provider.id,
            upstreamModel,
            slug: `s5-311/${tag}`,
            pricing: { inputPerMTok: '1', outputPerMTok: '1' },
            capabilities: { tools: true },
          },
          201,
        ),
      )
    ).body;
    return model.slug;
  }

  const brokenHistory = (model) => ({
    model,
    messages: [
      { role: 'user', content: 'Fix the bug.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
          { id: 'call_b', type: 'function', function: { name: 'read', arguments: "{'p': 'b'" } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
      { role: 'user', content: 'Continue.' },
      { role: 'tool', tool_call_id: 'call_trimmed', content: 'stale' },
    ],
  });

  let claude;
  let gpt;
  let broken;
  let plainKey;
  let repairKey;
  const setup = async () => {
    if (repairKey) return;
    claude = await mockModel('claude', 'anthropic', 'claude-sonnet-4-5', 'sk-ant-mock');
    gpt = await mockModel('gpt', 'openai-compatible', 'mock-small', 'sk-mock');
    broken = await mockModel(
      'broken',
      'openai-compatible',
      'mock-small',
      `mock:text_b64=${Buffer.from(BROKEN).toString('base64url')}`,
    );
    plainKey = (await createKey('311-plain')).key;
    repairKey = (await createKey('311-repair', { repair: ['json', 'tools'] })).key;
    await waitFor('gateway to know the 31.1 models', async () => {
      const res = await fetch(`${urls.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${repairKey}` },
      });
      const ids = ((await res.json()).data ?? []).map((m) => m.id);
      return [claude, gpt, broken].every((slug) => ids.includes(slug));
    });
  };

  await scenario(
    '31.1 an unpaired tool history reaches Claude and an OpenAI model without a 400 when repair is on',
    async () => {
      await setup();
      for (const model of [claude, gpt]) {
        const plain = await chat(plainKey, brokenHistory(model));
        assert.equal(plain.response.status, 400, `${model} without repair: ${plain.text}`);
        const viaKey = await chat(repairKey, brokenHistory(model));
        assert.equal(viaKey.response.status, 200, `${model} with the key's repair: ${viaKey.text}`);
        const viaHeader = await chat(plainKey, brokenHistory(model), {
          'x-dirouter-repair': 'tools',
        });
        assert.equal(viaHeader.response.status, 200, `${model} with the header: ${viaHeader.text}`);
        const off = await chat(repairKey, brokenHistory(model), { 'x-dirouter-repair': 'off' });
        assert.equal(off.response.status, 400, `${model} with repair switched off by header`);
      }
    },
  );

  await scenario(
    '31.1 a broken JSON answer to response_format is repaired; valid and streamed answers are not touched',
    async () => {
      await setup();
      const body = {
        model: broken,
        messages: [{ role: 'user', content: 'weather as JSON' }],
        response_format: { type: 'json_object' },
      };
      const plain = await chat(plainKey, body);
      assert.equal(plain.body.choices[0].message.content, BROKEN);
      const repaired = await chat(repairKey, body);
      assert.equal(repaired.response.status, 200, repaired.text);
      assert.deepEqual(JSON.parse(repaired.body.choices[0].message.content), {
        city: 'Tehran',
        temp: 21,
      });
      const stream = await chat(repairKey, { ...body, stream: true });
      assert.match(stream.text, /```json/);
    },
  );
}
