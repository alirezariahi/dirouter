/**
 * Card 30.5: Realtime API over WebSocket, through Traefik to the gateway and on to the mock
 * provider's realtime endpoint. Uses Node's built-in WebSocket the way a browser does: the key or
 * a client secret travels in the `openai-insecure-api-key.` subprotocol.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { request, sql, urls, waitFor } from '../harness.mjs';

/** One second of PCM16 at 24 kHz; the mock counts it as 10 audio tokens. */
const SECOND_OF_AUDIO = Buffer.alloc(48_000).toString('base64');
const wsUrl = (path) => `${urls.gateway.replace(/^http/, 'ws')}${path}`;

/** Opens a session and collects its events; `next(type)` waits for the next one of a type. */
function open(path, protocols) {
  const socket = new WebSocket(wsUrl(path), protocols);
  const events = [];
  const waiting = [];
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(String(message.data));
    const at = waiting.findIndex((w) => w.type === event.type);
    if (at === -1) events.push(event);
    else waiting.splice(at, 1)[0].resolve(event);
  });
  const opened = new Promise((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    socket.addEventListener('error', () => resolve(false));
  });
  const closed = new Promise((resolve) => {
    socket.addEventListener('close', (event) =>
      resolve({ code: event.code, reason: event.reason }),
    );
  });
  const next = (type, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const at = events.findIndex((e) => e.type === type);
      if (at !== -1) {
        resolve(events.splice(at, 1)[0]);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`no ${type} event within ${String(timeoutMs)} ms`)),
        timeoutMs,
      );
      waiting.push({
        type,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  const send = (event) => socket.send(JSON.stringify(event));
  return { socket, opened, closed, next, send };
}

export async function register({ scenario, cleanups, org, createKey }) {
  const tag = randomUUID().slice(0, 6);
  let model;

  /** A mock-backed realtime model with audio token prices, created once. */
  async function realtimeModel() {
    if (model) return model;
    const provider = (
      await org(
        'POST',
        'providers',
        {
          name: `e2e-rt-${tag}`,
          type: 'openai',
          baseUrl: 'http://mock-provider:8090/v1',
          credentials: [{ name: 'k', secret: 'mock-secret' }],
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
    const created = (
      await org(
        'POST',
        'models',
        {
          providerId: provider.id,
          upstreamModel: 'gpt-realtime',
          slug: `e2e-${tag}/realtime`,
          pricing: {
            inputPerMTok: '4',
            outputPerMTok: '16',
            audioInputPerMTok: '32',
            audioOutputPerMTok: '64',
          },
          capabilities: { realtime: true },
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${created.id}`, undefined, null));
    model = created.slug;
    return model;
  }

  const realtimeRows = (keyId, count) =>
    waitFor(`${String(count)} realtime rows in request_log`, async () => {
      const rows = await sql(
        `SELECT id, cost_usd, input_tokens, output_tokens, media::text FROM request_log
          WHERE api_key_id = '${keyId}' AND inbound_api = 'openai.realtime' ORDER BY id`,
      );
      const list = rows ? rows.split('\n') : [];
      if (list.length < count) return undefined;
      return list.map((row) => {
        const [id, cost, input, output, media] = row.split('|');
        return { id, cost, input: Number(input), output: Number(output), media: JSON.parse(media) };
      });
    });

  await scenario(
    '30.5 realtime: a browser session with a client secret through Traefik, billed as audio and text',
    async () => {
      const slug = await realtimeModel();
      const key = await createKey('realtime');
      const minted = await request(
        `${urls.gateway}/v1/realtime/client_secrets`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            session: { type: 'realtime', model: slug, instructions: 'Be brief.' },
          }),
        },
        200,
      );
      assert.match(minted.body.value, /^ek_/);
      assert.ok(!minted.text.includes(key.key), 'the client secret never contains the key');

      const session = open(`/v1/realtime?model=${encodeURIComponent(slug)}`, [
        'realtime',
        `openai-insecure-api-key.${minted.body.value}`,
      ]);
      assert.equal(await session.opened, true, 'Traefik passes the WebSocket upgrade through');
      assert.equal(session.socket.protocol, 'realtime');
      const created = await session.next('session.created');
      assert.equal(created.session.model, slug);
      const updated = await session.next('session.updated');
      assert.equal(updated.session.instructions, 'Be brief.');

      session.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
      session.send({ type: 'input_audio_buffer.commit' });
      await session.next('input_audio_buffer.committed');
      session.send({ type: 'response.create' });
      await session.next('response.output_audio.delta');
      const done = await session.next('response.done');
      assert.equal(done.response.status, 'completed');
      session.send({ type: 'response.create' });
      await session.next('response.done');
      session.socket.close(1000, 'done');
      await session.closed;

      // Each response is one request_log row; audio and text are counted and priced apart.
      const rows = await realtimeRows(key.id, 2);
      const [first] = rows;
      assert.equal(first.input, 0);
      assert.equal(first.output, 10);
      assert.equal(first.media.audioInputTokens, 10);
      assert.equal(first.media.audioOutputTokens, 10);
      // Text: 10 out × $16/M; audio: 10 in × $32/M + 10 out × $64/M.
      assert.equal(first.media.textCostUsd, '0.00016000');
      assert.equal(first.media.audioCostUsd, '0.00096000');
      assert.equal(first.cost, '0.00112000');
      assert.equal(rows[1].media.sessionId, first.media.sessionId);
    },
  );

  await scenario(
    '30.5 realtime: the handshake refuses a bad key and a non-realtime model',
    async () => {
      const slug = await realtimeModel();
      const bad = open(`/v1/realtime?model=${encodeURIComponent(slug)}`, [
        'realtime',
        'openai-insecure-api-key.not-a-key',
      ]);
      assert.equal(await bad.opened, false);
      const key = await createKey('realtime-refused');
      const chat = open('/v1/realtime?model=mock/small', [
        'realtime',
        `openai-insecure-api-key.${key.key}`,
      ]);
      assert.equal(await chat.opened, false);
      const status = await fetch(`${urls.gateway}/v1/realtime/client_secrets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session: { model: 'mock/small' } }),
      });
      assert.equal(status.status, 400);
    },
  );

  await scenario(
    '30.5 realtime: a session whose budget runs out is closed with a clear error',
    async () => {
      const slug = await realtimeModel();
      const key = await createKey('realtime-budget', {
        budgets: [{ period: 'daily', limitUsd: '0.0005' }],
      });
      const session = open(`/v1/realtime?model=${encodeURIComponent(slug)}`, [
        'realtime',
        `openai-insecure-api-key.${key.key}`,
      ]);
      assert.equal(await session.opened, true);
      await session.next('session.created');
      session.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
      session.send({ type: 'input_audio_buffer.commit' });
      session.send({ type: 'response.create' });
      await session.next('response.done');
      const error = await session.next('error');
      assert.equal(error.error.code, 'budget_exceeded');
      assert.match(error.error.message, /budget exceeded/);
      const closed = await session.closed;
      assert.equal(closed.code, 1008);
      // The spend is in the log, and the next session is refused at the handshake.
      await realtimeRows(key.id, 1);
      const again = open(`/v1/realtime?model=${encodeURIComponent(slug)}`, [
        'realtime',
        `openai-insecure-api-key.${key.key}`,
      ]);
      assert.equal(await again.opened, false);
    },
  );
}
