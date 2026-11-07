/**
 * parser و writer مقاوم Server-Sent Events.
 *
 * - chunkهای شبکه هر جایی بریده می‌شوند (وسط خط یا وسط کاراکتر چندبایتی فارسی)؛
 *   TextDecoder با `stream: true` و بافر خط این را مدیریت می‌کند.
 * - پایان خط `\n`، `\r\n` و `\r`؛ چند خط `data:` با `\n` به هم می‌پیوندند؛ خطوط `:` (کامنت/heartbeat) نادیده گرفته می‌شوند.
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
  /** \r آخر chunk قبلی؛ اگر chunk بعدی با \n شروع شود یک پایان خط است، نه دو. */
  #pendingCr = false;

  /** chunk جدید؛ رویدادهای کامل‌شده را برمی‌گرداند. */
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

  /** پایان stream: باقیماندهٔ بافر را به‌عنوان رویداد آخر برمی‌گرداند. */
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

/** یک رویداد SSE به‌صورت متن آمادهٔ نوشتن. */
export function encodeSse(event: { event?: string; data: string }): string {
  const lines = event.data.split(/\r\n|\r|\n/).map((l) => `data: ${l}`);
  return `${event.event ? `event: ${event.event}\n` : ''}${lines.join('\n')}\n\n`;
}

/** heartbeat کامنت SSE؛ کلاینت‌ها نادیده می‌گیرند ولی اتصال idle نمی‌شود. */
export const SSE_HEARTBEAT = ': ping\n\n';
