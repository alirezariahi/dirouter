/** Mock endpoints of card 30.4: legacy completions, image edits and variations, translations. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const app = buildServer();
let base = '';

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});
afterAll(() => app.close());

const json = (path: string, body: unknown, key = 'k') =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

function form(parts: [string, string, string?][]) {
  const body = parts
    .map(([name, value, filename]) =>
      filename
        ? `--b\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${value}\r\n`
        : `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join('');
  return { body: `${body}--b--\r\n`, type: 'multipart/form-data; boundary=b' };
}
const upload = (path: string, parts: [string, string, string?][], auth = true) => {
  const f = form(parts);
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': f.type, ...(auth ? { authorization: 'Bearer k' } : {}) },
    body: f.body,
  });
};

describe('legacy completions', () => {
  it('answers instruct models, refuses chat models, streams and honours directives', async () => {
    const res = await json('/v1/completions', {
      model: 'gpt-3.5-turbo-instruct',
      prompt: ['a', 'b'],
      n: 2,
      max_tokens: 2,
      echo: true,
      suffix: '!',
    });
    const body = (await res.json()) as { choices: { text: string; finish_reason: string }[] };
    expect(body.choices).toHaveLength(4);
    expect(body.choices[0]).toMatchObject({ text: 'aHello from!', finish_reason: 'length' });
    expect((await json('/v1/completions', { model: 'gpt-4o', prompt: 'x' })).status).toBe(404);
    const stream = await json('/openai/deployments/davinci-002/completions', {
      prompt: 'x',
      stream: true,
    });
    expect(await stream.text()).toMatch(/text_completion[\s\S]*usage[\s\S]*\[DONE\]/);
    expect(
      (await json('/v1/completions', { model: 'babbage-002' }, 'mock:status=429')).status,
    ).toBe(429);
  });
});

describe('image edits, variations and translations', () => {
  it('edits count uploaded images; dall-e answers with URLs unless asked for base64', async () => {
    const gpt = await upload('/v1/images/edits', [
      ['model', 'gpt-image-1'],
      ['prompt', 'abcd'],
      ['image[]', 'PNG', '1.png'],
      ['image[]', 'PNG', '2.png'],
    ]);
    expect(await gpt.json()).toMatchObject({ usage: { input_tokens: 131, output_tokens: 272 } });
    const dalle = await upload('/v1/images/variations', [
      ['model', 'dall-e-2'],
      ['n', '2'],
      ['image', 'PNG', 'a.png'],
    ]);
    expect(((await dalle.json()) as { data: { url: string }[] }).data).toEqual([
      { url: 'https://mock.invalid/variations.png' },
      { url: 'https://mock.invalid/variations.png' },
    ]);
    const b64 = await upload('/v1/images/variations', [
      ['response_format', 'b64_json'],
      ['image', 'PNG', 'a.png'],
    ]);
    expect(
      ((await b64.json()) as { data: { b64_json?: string }[] }).data[0]?.b64_json,
    ).toBeTruthy();
    expect((await upload('/v1/images/edits', [['prompt', 'x']])).status).toBe(400);
    expect((await upload('/v1/images/edits', [['image', 'P', 'a.png']], false)).status).toBe(401);
  });

  it('translations answer in English, verbose with the task', async () => {
    const plain = await upload('/v1/audio/translations', [['file', 'RIFF', 'a.wav']]);
    expect(await plain.json()).toEqual({ text: 'Hello from the DiRouter mock translator.' });
    const verbose = await upload('/v1/audio/translations', [
      ['response_format', 'verbose_json'],
      ['file', 'RIFF', 'a.wav'],
    ]);
    expect(await verbose.json()).toMatchObject({ task: 'translate', language: 'english' });
    expect((await upload('/v1/audio/translations', [['file', 'x', 'a.wav']], false)).status).toBe(
      401,
    );
  });
});
