/**
 * Fake OpenAI Realtime API over WebSocket (card 30.5) at `/v1/realtime?model=…` (OpenAI) and
 * `/openai/v1/realtime?model=…` (Azure).
 *
 * It speaks enough of the protocol for clients and the gateway to be tested end to end: the
 * session events, the input audio buffer, conversation items and responses with text and audio
 * deltas, cancellation, and a `response.done` whose usage splits text and audio tokens. Event
 * names follow the GA API, or the beta API when the client sends `OpenAI-Beta: realtime=v1`.
 *
 * Usage is deterministic: input text is one token per 4 characters of the conversation, input
 * audio is 10 tokens per second of committed PCM16 at 24 kHz (48,000 bytes), and each response
 * produces `text` (one token per 4 characters) plus 2 audio tokens per delta when audio is on.
 * Directives (`mock:status=401`, `chunks=10,chunk_delay=50`, `text=…`, `no_usage`) work as on the
 * HTTP endpoints.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import type { Scenario } from './scenario.js';

/** PCM16 mono at 24 kHz. */
const BYTES_PER_SECOND = 48_000;
const SILENCE = Buffer.alloc(4_800).toString('base64');

export interface RealtimeStats {
  /** Sessions opened since the last reset, and the ones open now. */
  sessions: number;
  open: number;
  /** Client event types received, in order (last 200). */
  events: string[];
  /** Upstream model and auth header of the last session. */
  lastModel?: string;
  lastAuthorization?: string;
  lastBeta?: boolean;
  /** Sessions closed by the client while a response was still streaming. */
  cutMidResponse: number;
}

export const newRealtimeStats = (): RealtimeStats => ({
  sessions: 0,
  open: 0,
  events: [],
  cutMidResponse: 0,
});

interface Item {
  id: string;
  role: string;
  text: string;
  audioBytes: number;
}

const tokens = (text: string) => Math.ceil(text.length / 4);

function reject(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({ error: { message, type: 'invalid_request_error', code: status } });
  socket.end(
    `HTTP/1.1 ${String(status)} Mock\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`,
  );
}

export function registerRealtime(
  app: FastifyInstance,
  options: {
    scenario: (headers: IncomingMessage['headers']) => Scenario;
    stats: () => RealtimeStats;
  },
): void {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('realtime') ? 'realtime' : false),
  });

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname !== '/v1/realtime' && url.pathname !== '/openai/v1/realtime') {
      reject(socket, 404, 'not found');
      return;
    }
    const auth = req.headers.authorization ?? req.headers['api-key'];
    if (typeof auth !== 'string' || auth === '') {
      reject(socket, 401, 'missing credentials');
      return;
    }
    const scenario = options.scenario(req.headers);
    if (scenario.status) {
      reject(socket, scenario.status, `mock status ${String(scenario.status)}`);
      return;
    }
    const model = url.searchParams.get('model');
    if (!model) {
      reject(socket, 400, 'model is required');
      return;
    }
    const beta = /realtime=v1/.test(String(req.headers['openai-beta'] ?? ''));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const stats = options.stats();
      stats.sessions++;
      stats.open++;
      stats.lastModel = model;
      stats.lastAuthorization = auth;
      stats.lastBeta = beta;
      runSession(ws, { model, beta, scenario, stats: options.stats });
    });
  });
  app.addHook('onClose', (_app, done) => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    done();
  });
}

function runSession(
  ws: WebSocket,
  ctx: { model: string; beta: boolean; scenario: Scenario; stats: () => RealtimeStats },
) {
  const names = ctx.beta
    ? {
        itemAdded: 'conversation.item.created',
        text: 'response.text.delta',
        textDone: 'response.text.done',
        audio: 'response.audio.delta',
        audioDone: 'response.audio.done',
        transcript: 'response.audio_transcript.delta',
      }
    : {
        itemAdded: 'conversation.item.added',
        text: 'response.output_text.delta',
        textDone: 'response.output_text.done',
        audio: 'response.output_audio.delta',
        audioDone: 'response.output_audio.done',
        transcript: 'response.output_audio_transcript.delta',
      };
  const session: Record<string, unknown> = {
    id: `sess_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    object: 'realtime.session',
    ...(ctx.beta ? {} : { type: 'realtime' }),
    model: ctx.model,
    instructions: '',
    ...(ctx.beta ? { modalities: ['text', 'audio'] } : { output_modalities: ['audio'] }),
  };
  // Counted on the stats this session started with, so a reset never goes negative.
  const own = ctx.stats();
  const items: Item[] = [];
  let buffer = 0;
  let active: { id: string; cancelled: boolean } | undefined;
  let closed = false;

  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ event_id: `event_${randomUUID().slice(0, 12)}`, ...event }));
  };
  const error = (message: string, code: string, eventId?: string) => {
    send({
      type: 'error',
      error: { type: 'invalid_request_error', code, message, param: null, event_id: eventId },
    });
  };
  const addItem = (item: Item, previous?: string) => {
    items.push(item);
    const shaped = {
      id: item.id,
      object: 'realtime.item',
      type: 'message',
      role: item.role,
      content: [
        item.audioBytes > 0
          ? { type: 'input_audio', transcript: null }
          : { type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text },
      ],
    };
    send({ type: names.itemAdded, previous_item_id: previous ?? null, item: shaped });
    if (!ctx.beta) send({ type: 'conversation.item.done', item: shaped });
  };
  const audioOn = () => {
    const modalities = (session.output_modalities ?? session.modalities) as string[] | undefined;
    return !Array.isArray(modalities) || modalities.includes('audio');
  };

  async function respond(overrides: Record<string, unknown>) {
    const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const current = { id, cancelled: false };
    active = current;
    const response = { id, object: 'realtime.response', status: 'in_progress', output: [] };
    send({ type: 'response.created', response });
    const text = ctx.scenario.text;
    const audio = audioOn() && overrides.output_modalities?.toString() !== 'text';
    const itemId = `item_${randomUUID().slice(0, 12)}`;
    const pieces = Math.max(1, ctx.scenario.chunks);
    const step = Math.ceil(text.length / pieces);
    let sent = 0;
    let audioTokens = 0;
    for (let i = 0; i < pieces; i++) {
      if (ctx.scenario.chunkDelayMs > 0)
        await new Promise((done) => setTimeout(done, ctx.scenario.chunkDelayMs));
      if (current.cancelled || closed) break;
      const delta = text.slice(i * step, (i + 1) * step);
      sent += delta.length;
      if (audio) {
        audioTokens += 2;
        send({ type: names.audio, response_id: id, item_id: itemId, delta: SILENCE });
        send({ type: names.transcript, response_id: id, item_id: itemId, delta });
      } else send({ type: names.text, response_id: id, item_id: itemId, delta });
    }
    if (closed) {
      own.cutMidResponse++;
      return;
    }
    if (!current.cancelled)
      send({ type: audio ? names.audioDone : names.textDone, item_id: itemId });
    const inputText = items.reduce((n, item) => n + tokens(item.text), 0);
    const inputAudio = Math.ceil(
      (items.reduce((n, item) => n + item.audioBytes, 0) / BYTES_PER_SECOND) * 10,
    );
    const outputText = tokens(text.slice(0, sent));
    items.push({ id: itemId, role: 'assistant', text: text.slice(0, sent), audioBytes: 0 });
    active = undefined;
    send({
      type: 'response.done',
      response: {
        ...response,
        status: current.cancelled ? 'cancelled' : 'completed',
        ...(ctx.scenario.noUsage
          ? {}
          : {
              usage: {
                total_tokens: inputText + inputAudio + outputText + audioTokens,
                input_tokens: inputText + inputAudio,
                output_tokens: outputText + audioTokens,
                input_token_details: {
                  text_tokens: inputText,
                  audio_tokens: inputAudio,
                  image_tokens: 0,
                  cached_tokens: 0,
                  cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
                },
                output_token_details: { text_tokens: outputText, audio_tokens: audioTokens },
              },
            }),
      },
    });
  }

  send({ type: 'session.created', session });

  ws.on('message', (data: RawData) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(
        (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString(),
      ) as Record<string, unknown>;
    } catch {
      error('could not parse the event as JSON', 'invalid_json');
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
    const stats = ctx.stats();
    stats.events.push(type);
    if (stats.events.length > 200) stats.events.shift();
    switch (type) {
      case 'session.update': {
        const update = (event.session ?? {}) as Record<string, unknown>;
        Object.assign(session, update, { id: session.id, object: session.object });
        send({ type: 'session.updated', session });
        break;
      }
      case 'input_audio_buffer.append': {
        const audio = typeof event.audio === 'string' ? event.audio : '';
        buffer += Buffer.from(audio, 'base64').length;
        break;
      }
      case 'input_audio_buffer.clear':
        buffer = 0;
        send({ type: 'input_audio_buffer.cleared' });
        break;
      case 'input_audio_buffer.commit': {
        if (buffer === 0) {
          error('buffer too small', 'input_audio_buffer_commit_empty', eventId);
          break;
        }
        const id = `item_${randomUUID().slice(0, 12)}`;
        const previous = items.at(-1)?.id ?? null;
        send({ type: 'input_audio_buffer.committed', previous_item_id: previous, item_id: id });
        addItem({ id, role: 'user', text: '', audioBytes: buffer }, previous ?? undefined);
        buffer = 0;
        break;
      }
      case 'conversation.item.create': {
        const item = (event.item ?? {}) as { id?: string; role?: string; content?: unknown };
        const content = Array.isArray(item.content)
          ? (item.content as Record<string, unknown>[])
          : [];
        const text = content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ');
        const audioBytes = content.reduce(
          (n, c) => n + (typeof c.audio === 'string' ? Buffer.from(c.audio, 'base64').length : 0),
          0,
        );
        addItem(
          {
            id: item.id ?? `item_${randomUUID().slice(0, 12)}`,
            role: item.role ?? 'user',
            text,
            audioBytes,
          },
          items.at(-1)?.id,
        );
        break;
      }
      case 'conversation.item.delete': {
        const at = items.findIndex((i) => i.id === event.item_id);
        if (at === -1) error('item not found', 'item_not_found', eventId);
        else {
          items.splice(at, 1);
          send({ type: 'conversation.item.deleted', item_id: event.item_id });
        }
        break;
      }
      case 'response.create':
        if (active) {
          error(
            'a response is already in progress',
            'conversation_already_has_active_response',
            eventId,
          );
          break;
        }
        void respond((event.response ?? {}) as Record<string, unknown>);
        break;
      case 'response.cancel':
        if (active) active.cancelled = true;
        else error('no active response', 'response_cancel_not_active', eventId);
        break;
      default:
        error(`Invalid value: '${type}'`, 'invalid_value', eventId);
    }
  });
  ws.on('close', () => {
    closed = true;
    own.open--;
  });
}
