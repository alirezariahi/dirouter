/**
 * Live view stream (card 24.4): reads control-api's Server-Sent Events with fetch (EventSource
 * cannot send the bearer token) and reports when the stream is up or has dropped, so the page can
 * fall back to polling.
 */
import { apiEventStream } from './api';

export interface LiveRow {
  id: string;
  createdAt: string;
  requestedModel: string;
  providerId: string | null;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number;
  stream: boolean;
}

/** Splits an SSE byte stream into `{event, data}` frames; comments (keep-alives) are skipped. */
export function sseParser(onFrame: (event: string, data: string) => void) {
  let buffer = '';
  return (text: string) => {
    buffer += text.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) onFrame(event, data.join('\n'));
    }
  };
}

export interface LiveStreamHandlers {
  /** The stream is subscribed: every request finished from now on arrives as an event. */
  onOpen: () => void;
  onEvent: (row: LiveRow) => void;
  /** The stream failed or ended; the page should poll until it reconnects. */
  onDrop: () => void;
}

/** Opens the stream until `signal` aborts; `onDrop` fires once when it fails or ends. */
export async function connectLive(
  orgId: string,
  handlers: LiveStreamHandlers,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<void> {
  try {
    const res = await apiEventStream(`/orgs/${orgId}/stats/live/stream`, signal, fetchImpl);
    if (!res.body) throw new Error('no stream body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const feed = sseParser((event, data) => {
      if (event === 'ready') handlers.onOpen();
      else if (event === 'request') {
        try {
          handlers.onEvent(JSON.parse(data) as LiveRow);
        } catch {
          // A malformed frame is skipped; the next poll covers it.
        }
      }
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Network error, 4xx/5xx or abort: handled below.
  }
  if (!signal.aborted) handlers.onDrop();
}

/**
 * Rows pushed over the stream merged into the latest poll: newest first, one row per request id,
 * only the last 15 minutes and at most `limit` rows (the poll's own window and size).
 */
export function mergeLive(
  polled: LiveRow[],
  pushed: LiveRow[],
  now: number,
  limit = 50,
): LiveRow[] {
  const seen = new Set<string>();
  return [...pushed, ...polled]
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return now - Date.parse(row.createdAt) <= 15 * 60_000;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}
