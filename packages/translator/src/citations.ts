/**
 * Citations and log probabilities between the formats (card 31.7).
 *
 * Citations live on canonical text parts. A `url` citation (a web page) travels everywhere:
 * Anthropic `web_search_result_location`, OpenAI Chat `annotations[].url_citation`, Responses
 * `output_text.annotations[]` (`url_citation`) and Gemini `groundingMetadata`. A `document`
 * citation (a passage of a document in the request) only exists in Anthropic's API.
 *
 * Offsets: OpenAI and Responses count characters of the whole message text, Gemini counts UTF-8
 * bytes of the candidate text; canonical `start`/`end` are characters of the text part itself.
 */
import type { CanonicalCitation, CanonicalPart, CanonicalResponse } from '@dirouter/contracts';

type Json = Record<string, unknown>;
type TextPart = Extract<CanonicalPart, { type: 'text' }>;
type UrlCitation = Extract<CanonicalCitation, { kind: 'url' }>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
const asObject = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const list = (v: unknown): Json[] =>
  Array.isArray(v) ? v.map(asObject).filter((x): x is Json => x !== undefined) : [];

// ───────────── Anthropic ─────────────

/** An Anthropic text-block citation → canonical, or undefined for a kind it does not know. */
export function anthropicCitationIn(raw: unknown): CanonicalCitation | undefined {
  const c = asObject(raw);
  if (!c) return undefined;
  const citedText = str(c.cited_text) ?? '';
  const title = str(c.document_title) ?? str(c.title);
  const document = (location: 'char' | 'page' | 'block', from: unknown, to: unknown) => ({
    kind: 'document' as const,
    documentIndex: int(c.document_index) ?? int(c.search_result_index) ?? 0,
    ...(title ? { documentTitle: title } : {}),
    citedText,
    location,
    from: int(from) ?? 0,
    to: int(to) ?? 0,
  });
  switch (c.type) {
    case 'char_location':
      return document('char', c.start_char_index, c.end_char_index);
    case 'page_location':
      return document('page', c.start_page_number, c.end_page_number);
    case 'content_block_location':
    case 'search_result_location':
      return document('block', c.start_block_index, c.end_block_index);
    case 'web_search_result_location': {
      const url = str(c.url);
      if (!url) return undefined;
      return {
        kind: 'url',
        url,
        ...(str(c.title) ? { title: str(c.title) } : {}),
        ...(citedText ? { citedText } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Canonical → an Anthropic text-block citation. */
export function anthropicCitationOut(c: CanonicalCitation): Json {
  if (c.kind === 'url')
    return {
      type: 'web_search_result_location',
      url: c.url,
      title: c.title ?? null,
      cited_text: c.citedText ?? '',
      // Only Anthropic's own search issues this; a citation from elsewhere has none.
      encrypted_index: '',
    };
  const base = {
    cited_text: c.citedText,
    document_index: c.documentIndex,
    document_title: c.documentTitle ?? null,
  };
  if (c.location === 'char')
    return { type: 'char_location', ...base, start_char_index: c.from, end_char_index: c.to };
  if (c.location === 'page')
    return { type: 'page_location', ...base, start_page_number: c.from, end_page_number: c.to };
  return {
    type: 'content_block_location',
    ...base,
    start_block_index: c.from,
    end_block_index: c.to,
  };
}

// ───────────── message-wide offsets ─────────────

/** Each text part with its character offset in the concatenated message text. */
function textOffsets(parts: readonly CanonicalPart[]): { part: TextPart; offset: number }[] {
  const out: { part: TextPart; offset: number }[] = [];
  let offset = 0;
  for (const part of parts)
    if (part.type === 'text') {
      out.push({ part, offset });
      offset += part.text.length;
    }
  return out;
}

/** Url citations of the given text parts with offsets into their concatenated text. */
export function messageUrlCitations(
  parts: readonly CanonicalPart[],
): { url: string; title?: string; start: number; end: number }[] {
  return textOffsets(parts).flatMap(({ part, offset }) =>
    (part.citations ?? [])
      .filter((c): c is UrlCitation => c.kind === 'url')
      .map((c) => ({
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        start: offset + (c.start ?? 0),
        end: offset + (c.end ?? part.text.length),
      })),
  );
}

/** Attaches message-wide url spans to the text parts they fall in (mutates the parts). */
function attachSpans(
  parts: CanonicalPart[],
  spans: { url: string; title?: string; start: number; end: number }[],
): void {
  const texts = textOffsets(parts);
  for (const span of spans) {
    const home =
      texts.find((t) => span.start >= t.offset && span.start < t.offset + t.part.text.length) ??
      texts.at(-1);
    if (!home) continue;
    const length = home.part.text.length;
    const citation: UrlCitation = {
      kind: 'url',
      url: span.url,
      ...(span.title ? { title: span.title } : {}),
      start: Math.min(length, Math.max(0, span.start - home.offset)),
      end: Math.min(length, Math.max(0, span.end - home.offset)),
    };
    home.part.citations = [...(home.part.citations ?? []), citation];
  }
}

// ───────────── OpenAI Chat and Responses ─────────────

/** OpenAI Chat `message.annotations` → citations on the answer's text parts (mutates). */
export function openAIAnnotationsIn(parts: CanonicalPart[], annotations: unknown): void {
  attachSpans(
    parts,
    list(annotations).flatMap((a) => {
      const u = asObject(a.url_citation);
      const url = str(u?.url);
      if (a.type !== 'url_citation' || !url) return [];
      const title = str(u?.title);
      return [
        {
          url,
          ...(title ? { title } : {}),
          start: int(u?.start_index) ?? 0,
          end: int(u?.end_index) ?? 0,
        },
      ];
    }),
  );
}

/** Citations of the answer → OpenAI Chat `annotations` (url citations only). */
export function openAIAnnotationsOut(parts: readonly CanonicalPart[]): Json[] {
  return messageUrlCitations(parts).map((c) => ({
    type: 'url_citation',
    url_citation: {
      url: c.url,
      title: c.title ?? c.url,
      start_index: c.start,
      end_index: c.end,
    },
  }));
}

/** Citations of one Responses message → `output_text.annotations` (url citations only). */
export function responsesAnnotationsOut(parts: readonly CanonicalPart[]): Json[] {
  return messageUrlCitations(parts).map((c) => ({
    type: 'url_citation',
    url: c.url,
    title: c.title ?? c.url,
    start_index: c.start,
    end_index: c.end,
  }));
}

// ───────────── Gemini ─────────────

const charIndex = (text: string, bytes: number) =>
  Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8').length;
const byteIndex = (text: string, chars: number) => Buffer.byteLength(text.slice(0, chars), 'utf8');

/**
 * Gemini `groundingMetadata` (supports and their web chunks) and `citationMetadata` → citations
 * on the answer's text parts (mutates). Gemini offsets are UTF-8 bytes of the candidate text.
 */
export function geminiCitationsIn(parts: CanonicalPart[], candidate: unknown): void {
  const c = asObject(candidate);
  const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  const spans: { url: string; title?: string; start: number; end: number }[] = [];
  const grounding = asObject(c?.groundingMetadata);
  const chunks = list(grounding?.groundingChunks).map((chunk) => asObject(chunk.web));
  for (const support of list(grounding?.groundingSupports)) {
    const segment = asObject(support.segment);
    const start = charIndex(text, int(segment?.startIndex) ?? 0);
    const end = charIndex(text, int(segment?.endIndex) ?? 0);
    const indices = Array.isArray(support.groundingChunkIndices)
      ? support.groundingChunkIndices
      : [];
    for (const i of indices) {
      const web = typeof i === 'number' ? chunks[i] : undefined;
      const url = str(web?.uri);
      if (!url) continue;
      const title = str(web?.title);
      spans.push({ url, ...(title ? { title } : {}), start, end });
    }
  }
  for (const cite of list(asObject(c?.citationMetadata)?.citations)) {
    const url = str(cite.uri);
    if (!url) continue;
    const title = str(cite.title);
    spans.push({
      url,
      ...(title ? { title } : {}),
      start: charIndex(text, int(cite.startIndex) ?? 0),
      end: charIndex(text, int(cite.endIndex) ?? 0),
    });
  }
  attachSpans(parts, spans);
}

/** Citations of the answer → Gemini `groundingMetadata`, or undefined when there are none. */
export function geminiGroundingOut(parts: readonly CanonicalPart[]): Json | undefined {
  const citations = messageUrlCitations(parts);
  if (citations.length === 0) return undefined;
  const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  const chunks: { url: string; title?: string }[] = [];
  const chunkIndex = (url: string, title: string | undefined) => {
    const at = chunks.findIndex((c) => c.url === url);
    if (at !== -1) return at;
    chunks.push({ url, ...(title ? { title } : {}) });
    return chunks.length - 1;
  };
  const supports = citations.map((c) => ({
    segment: {
      startIndex: byteIndex(text, c.start),
      endIndex: byteIndex(text, c.end),
      text: text.slice(c.start, c.end),
    },
    groundingChunkIndices: [chunkIndex(c.url, c.title)],
  }));
  return {
    groundingChunks: chunks.map((c) => ({ web: { uri: c.url, title: c.title ?? c.url } })),
    groundingSupports: supports,
  };
}

// ───────────── log probabilities ─────────────

type Logprobs = NonNullable<CanonicalResponse['logprobs']>;

/** OpenAI Chat `choice.logprobs.content` → canonical. */
export function openAILogprobsIn(raw: unknown): Logprobs | undefined {
  const content = list(asObject(raw)?.content);
  if (content.length === 0) return undefined;
  return content.map((t) => ({
    token: str(t.token) ?? '',
    logprob: typeof t.logprob === 'number' ? t.logprob : 0,
    ...(Array.isArray(t.top_logprobs)
      ? {
          top: list(t.top_logprobs).map((x) => ({
            token: str(x.token) ?? '',
            logprob: typeof x.logprob === 'number' ? x.logprob : 0,
          })),
        }
      : {}),
  }));
}

const bytesOf = (token: string) => [...Buffer.from(token, 'utf8')];

/** Canonical → OpenAI token log probabilities (Chat `content[]`, Responses `logprobs[]`). */
export function openAILogprobsOut(logprobs: Logprobs): Json[] {
  return logprobs.map((t) => ({
    token: t.token,
    logprob: t.logprob,
    bytes: bytesOf(t.token),
    top_logprobs: (t.top ?? []).map((x) => ({
      token: x.token,
      logprob: x.logprob,
      bytes: bytesOf(x.token),
    })),
  }));
}

/** Gemini `candidate.logprobsResult` → canonical. */
export function geminiLogprobsIn(candidate: unknown): Logprobs | undefined {
  const result = asObject(asObject(candidate)?.logprobsResult);
  const chosen = list(result?.chosenCandidates);
  if (chosen.length === 0) return undefined;
  const tops = list(result?.topCandidates);
  return chosen.map((t, i) => {
    const top = list(tops[i]?.candidates);
    return {
      token: str(t.token) ?? '',
      logprob: typeof t.logProbability === 'number' ? t.logProbability : 0,
      ...(top.length
        ? {
            top: top.map((x) => ({
              token: str(x.token) ?? '',
              logprob: typeof x.logProbability === 'number' ? x.logProbability : 0,
            })),
          }
        : {}),
    };
  });
}

/** Canonical → Gemini `logprobsResult`. */
export function geminiLogprobsOut(logprobs: Logprobs): Json {
  return {
    chosenCandidates: logprobs.map((t) => ({ token: t.token, logProbability: t.logprob })),
    topCandidates: logprobs.map((t) => ({
      candidates: (t.top ?? []).map((x) => ({ token: x.token, logProbability: x.logprob })),
    })),
  };
}
