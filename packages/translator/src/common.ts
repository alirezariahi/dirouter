import type {
  CanonicalFinishReason,
  CanonicalImagePart,
  CanonicalPart,
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
