/**
 * Card 30.4: image edits and variations, audio translations and the legacy /v1/completions,
 * through Traefik to the gateway and the mock provider, each checked in request_log. The requests
 * are the multipart and JSON bodies the official SDK sends.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { sql, urls, waitFor } from '../harness.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** A silent 16 kHz mono WAV. */
function wav(seconds) {
  const samples = Math.round(seconds * 16_000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

export async function register({ scenario, cleanups, org, createKey }) {
  const tag = randomUUID().slice(0, 6);
  let setup;

  async function models() {
    if (setup) return setup;
    const provider = (
      await org(
        'POST',
        'providers',
        {
          name: `e2e-legacy-${tag}`,
          type: 'openai',
          baseUrl: 'http://mock-provider:8090/v1',
          credentials: [{ name: 'k', secret: 'mock-secret' }],
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
    const model = async (slug, upstreamModel, pricing, capabilities) => {
      const created = (
        await org(
          'POST',
          'models',
          {
            providerId: provider.id,
            upstreamModel,
            slug: `e2e-${tag}/${slug}`,
            pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
            capabilities,
          },
          201,
        )
      ).body;
      cleanups.push(() => org('DELETE', `models/${created.id}`, undefined, null));
      return created.slug;
    };
    setup = {
      image: await model(
        'image',
        'gpt-image-1',
        { inputPerMTok: '5', outputPerMTok: '40', perImageUsd: '0.01' },
        { images: true },
      ),
      dalle: await model('dalle', 'dall-e-2', { perImageUsd: '0.02' }, { images: true }),
      whisper: await model(
        'whisper',
        'whisper-1',
        { perSecondUsd: '0.0001' },
        { transcription: true },
      ),
      instruct: await model(
        'instruct',
        'gpt-3.5-turbo-instruct',
        { inputPerMTok: '1.5', outputPerMTok: '2' },
        { completions: true },
      ),
      key: await createKey('legacy'),
    };
    return setup;
  }

  const call = (key, path, body) =>
    fetch(`${urls.gateway}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  const logged = (res) => {
    const id = res.headers.get('x-request-id');
    return waitFor(`request ${String(id)} in request_log`, async () => {
      const row = await sql(
        `SELECT inbound_api, cost_usd, input_tokens, output_tokens, media::text FROM request_log WHERE id = '${String(id)}'`,
      );
      if (!row) return undefined;
      const [api, cost, input, output, media] = row.split('|');
      return {
        api,
        cost,
        input: Number(input),
        output: Number(output),
        media: JSON.parse(media || 'null'),
      };
    });
  };
  const image = () => new Blob([PNG], { type: 'image/png' });

  await scenario(
    '30.4 images: edits (one or several images, a mask) and variations are billed',
    async () => {
      const { image: gptImage, dalle, key } = await models();
      const edit = new FormData();
      edit.append('model', gptImage);
      edit.append('prompt', 'add a hat');
      edit.append('n', '2');
      edit.append('image', image(), 'image.png');
      const edited = await call(key.key, '/v1/images/edits', edit);
      assert.equal(edited.status, 200, await edited.clone().text());
      const body = await edited.json();
      assert.equal(body.data.length, 2);
      assert.match(body.data[0].b64_json, /^iVBOR/);
      // 3 prompt + 65 image tokens × $5/M + 544 × $40/M + 2 images × $0.01
      assert.deepEqual(await logged(edited), {
        api: 'openai.images',
        cost: '0.04210000',
        input: 68,
        output: 544,
        media: { images: 2 },
      });

      const several = new FormData();
      several.append('model', gptImage);
      several.append('prompt', 'merge');
      several.append('image[]', image(), 'a.png');
      several.append('image[]', image(), 'b.png');
      const merged = await call(key.key, '/v1/images/edits', several);
      assert.equal(merged.status, 200);
      assert.equal((await logged(merged)).input, 2 + 130);

      const masked = new FormData();
      masked.append('model', dalle);
      masked.append('prompt', 'a red door');
      masked.append('image', image(), 'image.png');
      masked.append('mask', image(), 'mask.png');
      const withMask = await call(key.key, '/v1/images/edits', masked);
      assert.equal((await withMask.json()).data[0].url, 'https://mock.invalid/edits.png');
      assert.equal((await logged(withMask)).cost, '0.02000000');

      const vary = new FormData();
      vary.append('model', dalle);
      vary.append('n', '3');
      vary.append('response_format', 'b64_json');
      vary.append('image', image(), 'image.png');
      const varied = await call(key.key, '/v1/images/variations', vary);
      assert.equal(varied.status, 200);
      assert.equal((await varied.json()).data.length, 3);
      assert.deepEqual(await logged(varied), {
        api: 'openai.images',
        cost: '0.06000000',
        input: 0,
        output: 0,
        media: { images: 3 },
      });
    },
  );

  await scenario('30.4 audio: translations return English text, billed per second', async () => {
    const { whisper, key } = await models();
    const upload = new FormData();
    upload.append('model', whisper);
    upload.append('response_format', 'verbose_json');
    upload.append('file', new Blob([wav(4)], { type: 'audio/wav' }), 'speech.wav');
    const res = await call(key.key, '/v1/audio/translations', upload);
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.task, 'translate');
    assert.equal(body.text, 'Hello from the DiRouter mock translator.');
    assert.deepEqual(await logged(res), {
      api: 'openai.translations',
      cost: '0.00040000',
      input: 0,
      output: 0,
      media: { seconds: 4 },
    });
  });

  await scenario(
    '30.4 completions: native for instruct models, mapped to chat otherwise',
    async () => {
      const { instruct, key } = await models();
      const native = await call(key.key, '/v1/completions', {
        model: instruct,
        prompt: 'Say hi',
        max_tokens: 5,
        n: 2,
      });
      assert.equal(native.status, 200, await native.clone().text());
      const body = await native.json();
      assert.equal(body.object, 'text_completion');
      assert.equal(body.choices.length, 2);
      assert.equal(body.choices[0].text, 'Hello from the DiRouter mock');
      // 2 prompt tokens × $1.5/M + 16 completion tokens × $2/M
      const row = await logged(native);
      assert.equal(row.api, 'openai.completions');
      assert.equal(row.cost, '0.00003500');

      const mapped = await call(key.key, '/v1/completions', {
        model: 'mock/small',
        prompt: 'Say hi',
        max_tokens: 50,
      });
      assert.equal(mapped.status, 200, await mapped.clone().text());
      const answer = await mapped.json();
      assert.equal(answer.choices[0].text, 'Hello from the DiRouter mock provider.');
      assert.equal(answer.choices[0].finish_reason, 'stop');
      const mappedRow = await logged(mapped);
      assert.equal(mappedRow.api, 'openai.completions');
      assert.ok(mappedRow.output > 0);

      const streamed = await call(key.key, '/v1/completions', {
        model: 'mock/small',
        prompt: 'Say hi',
        stream: true,
        stream_options: { include_usage: true },
      });
      const sse = await streamed.text();
      assert.match(sse, /"object":"text_completion"/);
      assert.match(sse, /"usage":\{"prompt_tokens":\d+/);
      assert.match(sse, /data: \[DONE\]\n\n$/);

      const refused = await call(key.key, '/v1/completions', {
        model: 'mock/small',
        prompt: 'x',
        echo: true,
      });
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error.message, /echo/);
    },
  );
}
