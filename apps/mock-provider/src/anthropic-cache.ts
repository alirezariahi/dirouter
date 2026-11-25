/**
 * Prompt caching on the Anthropic route (card 31.3), with Anthropic's rules: blocks are ordered
 * tools, system, messages; a block with `cache_control` (or the last block, for a top-level
 * `cache_control`) is a breakpoint, and the prompt up to and including it is a cacheable prefix.
 * A request reads the longest prefix an earlier request wrote and writes the rest up to its last
 * breakpoint. Without any breakpoint nothing is cached, exactly like the real API.
 */
type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;

/** The block without its marker: moving a breakpoint does not change the cached content. */
function plain(block: unknown): unknown {
  const object = asObject(block);
  if (!object) return block;
  const { cache_control: _marker, ...rest } = object;
  return Array.isArray(rest.content) ? { ...rest, content: rest.content.map(plain) } : rest;
}

const marked = (block: unknown) => asObject(block)?.cache_control !== undefined;

export class AnthropicPromptCache {
  readonly #seen = new Set<string>();

  lookup(body: Json): { read: number; write: number } {
    const system = body.system;
    const blocks: unknown[] = [
      ...((body.tools as unknown[] | undefined) ?? []),
      ...(typeof system === 'string'
        ? [{ type: 'text', text: system }]
        : ((system as unknown[] | undefined) ?? [])),
      ...((body.messages as Json[] | undefined) ?? []).flatMap((m) =>
        typeof m.content === 'string'
          ? [m.role, { type: 'text', text: m.content }]
          : [m.role, ...((m.content as unknown[] | undefined) ?? [])],
      ),
    ];
    const breakpoints: number[] = [];
    blocks.forEach((block, i) => {
      const nested = asObject(block)?.content;
      if (marked(block) || (Array.isArray(nested) && nested.some(marked))) breakpoints.push(i);
    });
    if (body.cache_control !== undefined && blocks.length > 0) breakpoints.push(blocks.length - 1);
    if (breakpoints.length === 0) return { read: 0, write: 0 };

    const prefixes = breakpoints.map((at) => JSON.stringify(blocks.slice(0, at + 1).map(plain)));
    const tokens = (prefix: string) => Math.max(1, Math.ceil(prefix.length / 4));
    let read = 0;
    for (const prefix of prefixes)
      if (this.#seen.has(prefix)) read = Math.max(read, tokens(prefix));
    const last = prefixes.at(-1) ?? '';
    const write = this.#seen.has(last) ? 0 : Math.max(0, tokens(last) - read);
    if (this.#seen.size > 1_000) this.#seen.clear();
    for (const prefix of prefixes) this.#seen.add(prefix);
    return { read, write };
  }

  clear(): void {
    this.#seen.clear();
  }
}

export const anthropicPromptCache = new AnthropicPromptCache();
