/**
 * Robust Server-Sent Events parser and writer.
 *
 * - Network chunks can be cut anywhere (mid-line or mid-way through a multibyte character);
 *   TextDecoder with `stream: true` and the line buffer handle this.
 * - Line endings are `\n`, `\r\n` and `\r`; multiple `data:` lines are joined with `\n`; `:` lines (comment/heartbeat) are ignored.
 */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  readonly #decoder = new TextDecoder('utf-8');
  #buffer = '';
  #event: string | undefined;
  #data: string[] = [];
  #id: string | undefined;
  /** Trailing \r of the previous chunk; if the next chunk starts with \n, it is one line ending, not two. */
  #pendingCr = false;

  /** New chunk; returns the completed events. */
  feed(chunk: Uint8Array | string): SseEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    if (this.#pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.#pendingCr = text.endsWith('\r');
    this.#buffer += text;

    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i++) {
      const ch = this.#buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      const line = this.#buffer.slice(start, i);
      if (ch === 13 && this.#buffer.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
      const event = this.#line(line);
      if (event) events.push(event);
    }
    this.#buffer = this.#buffer.slice(start);
    return events;
  }

  /** End of stream: returns the remaining buffer as the last event. */
  flush(): SseEvent[] {
    const rest = this.#decoder.decode();
    const events = rest ? this.feed(rest) : [];
    if (this.#buffer !== '') {
      const event = this.#line(this.#buffer);
      if (event) events.push(event);
      this.#buffer = '';
    }
    const last = this.#dispatch();
    if (last) events.push(last);
    return events;
  }

  #line(line: string): SseEvent | undefined {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#event = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        this.#id = value;
        break;
      default:
        break;
    }
    return undefined;
  }

  #dispatch(): SseEvent | undefined {
    if (this.#data.length === 0) {
      this.#event = undefined;
      return undefined;
    }
    const event: SseEvent = {
      data: this.#data.join('\n'),
      ...(this.#event !== undefined ? { event: this.#event } : {}),
      ...(this.#id !== undefined ? { id: this.#id } : {}),
    };
    this.#event = undefined;
    this.#data = [];
    return event;
  }
}

/** Encode an SSE event as text ready to write. */
export function encodeSse(event: { event?: string; data: string }): string {
  const lines = event.data.split(/\r\n|\r|\n/).map((l) => `data: ${l}`);
  return `${event.event ? `event: ${event.event}\n` : ''}${lines.join('\n')}\n\n`;
}

/** SSE comment heartbeat; clients ignore it, but the connection does not go idle. */
export const SSE_HEARTBEAT = ': ping\n\n';
