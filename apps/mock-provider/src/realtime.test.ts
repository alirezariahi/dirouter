/** Realtime mock (card 30.5): handshake checks, the event flow and deterministic usage. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { buildServer } from './server.js';

const app = buildServer();
let base = '';

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});
afterAll(() => app.close());

function open(path: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://${base}${path}`, { headers });
  const events: Record<string, unknown>[] = [];
  const waiting: [string, (e: Record<string, unknown>) => void][] = [];
  ws.on('message', (data) => {
    const event = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
    const at = waiting.findIndex(([type]) => type === event.type);
    if (at === -1) events.push(event);
    else waiting.splice(at, 1)[0]?.[1](event);
  });
  const status = new Promise<number>((resolve) => {
    ws.on('open', () => {
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', () => undefined);
  });
  const next = (type: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const at = events.findIndex((e) => e.type === type);
      if (at !== -1) resolve(events.splice(at, 1)[0] ?? {});
      else waiting.push([type, resolve]);
    });
  const send = (event: unknown) => {
    ws.send(typeof event === 'string' ? event : JSON.stringify(event));
  };
  return { ws, status, next, send };
}

describe('realtime mock', () => {
  it('checks the path, credentials, directives and model on the handshake', async () => {
    expect(await open('/v1/other?model=m', { authorization: 'Bearer k' }).status).toBe(404);
    expect(await open('/v1/realtime?model=m').status).toBe(401);
    expect(
      await open('/v1/realtime?model=m', { authorization: 'Bearer mock:status=429' }).status,
    ).toBe(429);
    expect(await open('/v1/realtime', { authorization: 'Bearer k' }).status).toBe(400);
  });

  it('runs a conversation with text and audio, cancellation and errors', async () => {
    await fetch(`http://${base}/__mock/reset`, { method: 'POST' });
    const s = open('/openai/v1/realtime?model=gpt-realtime', {
      'api-key': 'mock:chunks=4,chunk_delay=20',
    });
    expect(await s.status).toBe(101);
    expect((await s.next('session.created')).session).toMatchObject({ model: 'gpt-realtime' });
    s.send({ type: 'session.update', session: { output_modalities: ['text'] } });
    await s.next('session.updated');
    s.send('not json');
    expect((await s.next('error')).error).toMatchObject({ code: 'invalid_json' });
    s.send({ type: 'input_audio_buffer.commit' });
    expect((await s.next('error')).error).toMatchObject({
      code: 'input_audio_buffer_commit_empty',
    });
    s.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(100).toString('base64') });
    s.send({ type: 'input_audio_buffer.clear' });
    await s.next('input_audio_buffer.cleared');
    s.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(96_000).toString('base64') });
    s.send({ type: 'input_audio_buffer.commit' });
    await s.next('input_audio_buffer.committed');
    await s.next('conversation.item.added');
    s.send({
      type: 'conversation.item.create',
      item: { id: 'item_x', role: 'user', content: [{ type: 'input_text', text: 'Hello there!' }] },
    });
    await s.next('conversation.item.done');
    s.send({ type: 'conversation.item.delete', item_id: 'item_x' });
    await s.next('conversation.item.deleted');
    s.send({ type: 'conversation.item.delete', item_id: 'missing' });
    expect((await s.next('error')).error).toMatchObject({ code: 'item_not_found' });

    s.send({ type: 'response.create' });
    s.send({ type: 'response.create' });
    expect((await s.next('error')).error).toMatchObject({
      code: 'conversation_already_has_active_response',
    });
    await s.next('response.output_text.delta');
    const done = await s.next('response.done');
    // 2 s of audio = 20 tokens; text only, so no audio out.
    expect(done.response).toMatchObject({
      status: 'completed',
      usage: {
        input_token_details: { audio_tokens: 20, text_tokens: 0 },
        output_token_details: { text_tokens: 10, audio_tokens: 0 },
      },
    });

    s.send({ type: 'response.cancel' });
    expect((await s.next('error')).error).toMatchObject({ code: 'response_cancel_not_active' });
    s.send({ type: 'session.update', session: { output_modalities: ['audio'] } });
    s.send({ type: 'response.create' });
    await s.next('response.output_audio.delta');
    s.send({ type: 'response.cancel' });
    expect((await s.next('response.done')).response).toMatchObject({ status: 'cancelled' });
    s.send({ type: 'nonsense' });
    expect((await s.next('error')).error).toMatchObject({ code: 'invalid_value' });

    const stats = (await (await fetch(`http://${base}/__mock/stats`)).json()) as {
      realtime: { sessions: number; open: number; events: string[] };
    };
    expect(stats.realtime).toMatchObject({ sessions: 1, open: 1 });
    expect(stats.realtime.events).toContain('response.cancel');
    s.ws.close();
  });

  it('speaks the beta event names when asked', async () => {
    const s = open('/v1/realtime?model=m', {
      authorization: 'Bearer k',
      'openai-beta': 'realtime=v1',
    });
    expect(await s.status).toBe(101);
    await s.next('session.created');
    s.send({
      type: 'conversation.item.create',
      item: { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
    });
    await s.next('conversation.item.created');
    s.send({ type: 'response.create' });
    await s.next('response.audio.delta');
    await s.next('response.done');
    s.ws.close();
  });
});
