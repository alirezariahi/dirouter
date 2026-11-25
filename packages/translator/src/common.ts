import type {
  CanonicalAudioPart,
  CanonicalDocumentPart,
  CanonicalFinishReason,
  CanonicalImagePart,
  CanonicalPart,
  CanonicalRequest,
  CanonicalTextPart,
  CanonicalUsage,
} from '@dirouter/contracts';

/**
 * Reports fields that have no equivalent at the destination and were dropped. The gateway
 * logs these at debug level.
 */
export type DropReporter = (field: string, reason: string) => void;

export const ignoreDrops: DropReporter = () => undefined;

export interface TranslateOptions {
  onDrop?: DropReporter;
  /** Inbound APIs whose model lives in the URL path (Gemini) rather than the body. */
  model?: string;
}

export function textOf(parts: readonly CanonicalPart[]): string {
  return parts
    .filter((p): p is CanonicalTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Convert a data URL to a base64 source; a regular URL is left unchanged. */
export function imageFromUrl(url: string): CanonicalImagePart['source'] {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match)
    return {
      kind: 'base64',
      mediaType: match[1] ?? 'application/octet-stream',
      data: match[2] ?? '',
    };
  return { kind: 'url', url };
}

export function imageToUrl(source: CanonicalImagePart['source']): string {
  return source.kind === 'url' ? source.url : `data:${source.mediaType};base64,${source.data}`;
}

/** Safe JSON.parse for tool arguments; invalid arguments are converted to `{}`. */
export function parseToolArguments(raw: string, onDrop: DropReporter): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    onDrop('tool_call.arguments', 'invalid JSON replaced with {}');
    return {};
  }
}

export function emptyUsage(): CanonicalUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

export type FinishReasonMap<T extends string> = Record<CanonicalFinishReason, T>;

// ───────────── documents and audio (card 27.2) ─────────────

/**
 * Content the destination cannot carry. Thrown instead of dropping the part silently; the gateway
 * answers it with a 400 that names the part and the provider.
 */
export class UnsupportedContentError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedContentError';
  }
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
};

/** Media type from a file name or URL extension, or undefined. */
export function mediaTypeFromName(name: string | undefined): string | undefined {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(name ?? '')?.[1]?.toLowerCase();
  return ext ? EXTENSION_MEDIA_TYPES[ext] : undefined;
}

/**
 * A file given as a data URL or as bare base64 (OpenAI `file_data`, Responses `input_file`). Bare
 * base64 takes its media type from the file name, defaulting to PDF.
 */
export function documentFromFileData(
  fileData: string,
  filename: string | undefined,
): CanonicalDocumentPart['source'] {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(fileData);
  if (match)
    return {
      kind: 'base64',
      mediaType: match[1] ?? 'application/pdf',
      data: match[2] ?? '',
    };
  return {
    kind: 'base64',
    mediaType: mediaTypeFromName(filename) ?? 'application/pdf',
    data: fileData,
  };
}

/** Media type of a document, when it is known. */
export function documentMediaType(source: CanonicalDocumentPart['source']): string | undefined {
  switch (source.kind) {
    case 'base64':
      return source.mediaType;
    case 'url':
      return source.mediaType ?? mediaTypeFromName(source.url);
    case 'text':
      return source.mediaType ?? 'text/plain';
    case 'file':
      return undefined;
  }
}

/** OpenAI `input_audio.format` ⇄ media type. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
};

export function audioFormatToMediaType(format: string): string {
  return AUDIO_FORMATS[format] ?? `audio/${format}`;
}

/** The OpenAI `input_audio.format` for a media type, or undefined when OpenAI has none. */
export function audioMediaTypeToFormat(mediaType: string): 'wav' | 'mp3' | undefined {
  const type = mediaType.toLowerCase().split(';')[0]?.trim();
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') return 'wav';
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3';
  return undefined;
}

/** Human description of a document or audio part for error messages. */
export function describeMedia(part: CanonicalDocumentPart | CanonicalAudioPart): string {
  if (part.type === 'audio') return `audio (${part.source.kind})`;
  const type = documentMediaType(part.source);
  return `document${type ? ` ${type}` : ''} (${part.source.kind})`;
}

export interface MediaNeeds {
  documents: boolean;
  audio: boolean;
}

/** Which non-image media a request carries; the gateway routes only to targets that accept them. */
export function mediaNeeds(req: Pick<CanonicalRequest, 'messages'>): MediaNeeds {
  const needs: MediaNeeds = { documents: false, audio: false };
  for (const message of req.messages)
    for (const part of message.content) {
      if (part.type === 'document') needs.documents = true;
      else if (part.type === 'audio') needs.audio = true;
    }
  return needs;
}

// ───────────── prompt-cache markers (card 27.3) ─────────────

export interface CacheMarker {
  cache?: boolean;
  cacheTtl?: string;
}

/** Anthropic `cache_control` → canonical marker fields (`{}` when absent). */
export function cacheMarkerIn(cacheControl: unknown): CacheMarker {
  if (!cacheControl || typeof cacheControl !== 'object') return {};
  const ttl = (cacheControl as { ttl?: unknown }).ttl;
  return { cache: true, ...(typeof ttl === 'string' && ttl !== '' ? { cacheTtl: ttl } : {}) };
}

/** Canonical marker → Anthropic `{ cache_control }` (`{}` when the part is not a breakpoint). */
export function cacheControlOut(marker: CacheMarker): { cache_control?: Record<string, string> } {
  if (!marker.cache) return {};
  return {
    cache_control: { type: 'ephemeral', ...(marker.cacheTtl ? { ttl: marker.cacheTtl } : {}) },
  };
}

const SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'priority', 'scale']);
/** OpenAI's `service_tier` (card 31.5); anything else is not a tier DiRouter knows. */
export function serviceTierIn(
  value: unknown,
): NonNullable<CanonicalRequest['serviceTier']> | undefined {
  return typeof value === 'string' && SERVICE_TIERS.has(value)
    ? (value as NonNullable<CanonicalRequest['serviceTier']>)
    : undefined;
}
