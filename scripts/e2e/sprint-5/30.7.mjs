/**
 * Card 30.7: native provider pass-through. An untranslated endpoint (legacy text completions on
 * the mock provider) works through /passthrough/{provider}/*, is logged and priced; a key without
 * the grant and a path outside the provider's allow-list are refused.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { published, request, sql, urls, waitFor } from '../harness.mjs';

export function register({ scenario, cleanups, org, createKey }) {
  const tag = randomUUID().slice(0, 6);
  const slug = `s5-pass-${tag}`;
  let provider;
  let granted;
  let plain;

  async function setup() {
    if (provider) return;
    provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5 passthrough ${tag}`,
            slug,
            type: 'openai-compatible',
            baseUrl: 'http://mock-provider:8090/v1',
            options: { passthroughPaths: ['POST /completions'] },
            credentials: [{ name: 'mock', secret: `mock-e2e-passthrough-${tag}`, weight: 1 }],
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
            upstreamModel: 'gpt-3.5-turbo-instruct',
            slug: `s5-instruct-${tag}`,
            pricing: { inputPerMTok: '1', outputPerMTok: '2' },
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
    granted = await createKey('passthrough', { passthroughProviders: [slug] });
    plain = await createKey('no-passthrough');
  }

  const call = (key, path, body) =>
    request(`${urls.gateway}/passthrough/${slug}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  scenario('30.7 an untranslated endpoint works through pass-through and is logged', async () => {
    await setup();
    const { response, body } = await call(granted.key, '/completions', {
      model: 'gpt-3.5-turbo-instruct',
      prompt: 'Say hello',
    });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.object, 'text_completion');
    assert.equal(response.headers.get('x-dirouter-provider'), slug);
    const requestId = response.headers.get('x-request-id');
    let row = '';
    await waitFor('the pass-through request in request_log', async () => {
      row = await sql(
        `SELECT inbound_api, status, http_status, input_tokens, output_tokens, cost_usd > 0
           FROM request_log WHERE id = '${requestId}' AND api_key_id = '${granted.id}'`,
      );
      return row !== '';
    });
    const [api, status, httpStatus, input, output, priced] = row.split('|');
    assert.equal(api, 'passthrough');
    assert.equal(status, 'success');
    assert.equal(httpStatus, '200');
    assert.equal(Number(input), body.usage.prompt_tokens);
    assert.equal(Number(output), body.usage.completion_tokens);
    assert.equal(priced, 't');
  });

  scenario('30.7 a key without the pass-through grant is refused', async () => {
    await setup();
    const { response, body } = await call(plain.key, '/completions', { prompt: 'x' });
    assert.equal(response.status, 403);
    assert.match(body.error.message, /may not use pass-through/);
  });

  scenario('30.7 a path outside the allow-list is refused', async () => {
    await setup();
    const { response, body } = await call(granted.key, '/chat/completions', {
      model: 'gpt-3.5-turbo-instruct',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(response.status, 403);
    assert.match(body.error.message, /allow-list/);
  });
}
