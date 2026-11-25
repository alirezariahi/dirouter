/**
 * Web fetch as a service (card 30.8): reads a page a client names and returns its text.
 *
 * - SSRF: every hop goes through `webFetch` (upstream.ts), which in production refuses private,
 *   loopback and link-local addresses when connecting (so DNS rebinding is caught too) and for IP
 *   literals; only http and https, no credentials in the URL.
 * - Redirects are followed by hand, at most five, each one checked again.
 * - Bounded: one deadline for the whole fetch, and the body is read up to `maxBytes` (the rest is
 *   dropped and the answer says `truncated`).
 */
import { webFetch } from '../upstream.js';

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export class FetchRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const MAX_REDIRECTS = 5;
const TEXTUAL =
  /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript))/i;

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused('url must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new FetchRefused('only http and https URLs can be fetched');
  if (url.username || url.password) throw new FetchRefused('URLs with credentials are refused');
  return url;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16) || 0x20);
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)) || 0x20);
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Readable text of an HTML page: no scripts, styles or tags; block elements become new lines. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(
        /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi,
        '\n',
      )
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cleanTitle = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : undefined;
  return { ...(cleanTitle ? { title: cleanTitle } : {}), text };
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    if (value.length > room) {
      chunks.push(Buffer.from(value.subarray(0, room)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

export async function fetchPage(
  target: string,
  options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<FetchedPage> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const get = webFetch();
  let url = checkUrl(target);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await get(url.toString(), {
        headers: {
          accept:
            'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
          'user-agent': 'DiRouter-WebFetch/1.0',
        },
        signal,
      });
    } catch (error) {
      if (deadline.aborted) throw new FetchRefused('fetch timed out', 504);
      const code = (error as { code?: string; cause?: { code?: string } }).code;
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      if (code === 'EBLOCKED' || cause === 'EBLOCKED')
        throw new FetchRefused('the address is not public', 403);
      throw new FetchRefused('could not reach the address', 502);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new FetchRefused('too many redirects', 502);
      url = checkUrl(new URL(response.headers.get('location') ?? '', url).toString());
      continue;
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType !== '' && !TEXTUAL.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchRefused(`content type ${contentType.split(';')[0] ?? ''} is not text`, 415);
    }
    let read;
    try {
      read = await readBounded(response.body, options.maxBytes);
    } catch {
      if (deadline.aborted) throw new FetchRefused('fetch timed out', 504);
      throw new FetchRefused('the page could not be read', 502);
    }
    const text = read.bytes.toString('utf8');
    const html = contentType.includes('html') || (contentType === '' && /<html[\s>]/i.test(text));
    const page = html ? htmlToText(text) : { text };
    return {
      url: url.toString(),
      status: response.status,
      contentType: contentType.split(';')[0] ?? '',
      ...(page.title ? { title: page.title } : {}),
      content: page.text,
      bytes: read.bytes.length,
      truncated: read.truncated,
    };
  }
}
