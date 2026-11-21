/**
 * Context compression (card 13.3): the tool-call structure is never changed, savings are real, and
 * the evaluation set in test-fixtures/compression stays valid after compression.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CanonicalRequest,
  type CanonicalMessage,
  type CanonicalPart,
  type CompressionSettings,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  cleanToolOutput,
  compressRequest,
  structureOf,
  truncateMiddle,
  verifyStructure,
} from './compress.js';

const settings = (over: Partial<CompressionSettings> = {}): CompressionSettings => ({
  enabled: true,
  dedupe: true,
  maxToolResultChars: 300,
  keepRecentMessages: 2,
  dropOldReasoning: true,
  ...over,
});
const text = (value: string): CanonicalPart => ({ type: 'text', text: value });
const call = (id: string, name = 'Bash', args = '{}'): CanonicalPart => ({
  type: 'tool_call',
  id,
  name,
  arguments: args,
});
const result = (id: string, value: string): CanonicalPart => ({
  type: 'tool_result',
  toolCallId: id,
  content: [{ type: 'text', text: value }],
});
const request = (messages: CanonicalMessage[]): CanonicalRequest => ({
  inboundApi: 'anthropic.messages',
  model: 'm',
  system: [],
  messages,
  stream: false,
});
const chars = (messages: readonly CanonicalMessage[]) =>
  messages.reduce(
    (sum, message) =>
      sum +
      message.content.reduce((inner, part) => {
        if (part.type === 'text' || part.type === 'reasoning') return inner + part.text.length;
        if (part.type === 'tool_result')
          return (
            inner + part.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0)
          );
        return inner;
      }, 0),
    0,
  );
const resultText = (message: CanonicalMessage | undefined, index = 0) => {
  const part = message?.content[index];
  if (part?.type !== 'tool_result') return undefined;
  const first = part.content[0];
  return first?.type === 'text' ? first.text : undefined;
};
const big = 'line of output '.repeat(100);

describe('compressRequest', () => {
  const conversation = () =>
    request([
      { role: 'user', content: [text('start')] },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'thinking '.repeat(50) }, call('t1')],
      },
      { role: 'tool', content: [result('t1', big)] },
      { role: 'assistant', content: [call('t2')] },
      { role: 'tool', content: [result('t2', big)] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'only reasoning' }] },
      { role: 'assistant', content: [call('t3')] },
      { role: 'tool', content: [result('t3', big)] },
    ]);

  it('returns the same object when disabled or when nothing can be saved', () => {
    const input = conversation();
    expect(compressRequest(input, settings({ enabled: false })).request).toBe(input);
    const small = request([{ role: 'user', content: [text('hi')] }]);
    expect(compressRequest(small, settings()).request).toBe(small);
  });

  it('never removes messages or tool parts and keeps the pairing identical', () => {
    const input = conversation();
    const output = compressRequest(input, settings());
    expect(output.request.messages).toHaveLength(input.messages.length);
    expect(output.removedMessages).toBe(0);
    expect(structureOf(output.request.messages)).toBe(structureOf(input.messages));
    expect(verifyStructure(input.messages, output.request.messages)).toBe(true);
  });

  it('replaces a repeated tool result with a reference instead of dropping it', () => {
    const output = compressRequest(conversation(), settings());
    expect(output.dedupedParts).toBe(1);
    expect(resultText(output.request.messages[4])).toContain('t1');
    // The first occurrence is shortened, not referenced.
    expect(resultText(output.request.messages[2])).toContain('characters omitted');
  });

  it('two identical results of the same call id are not turned into a self-reference', () => {
    const input = request([
      { role: 'assistant', content: [call('t1')] },
      { role: 'tool', content: [result('t1', big), result('t1', big)] },
      { role: 'user', content: [text('a')] },
      { role: 'user', content: [text('b')] },
    ]);
    const output = compressRequest(input, settings({ maxToolResultChars: 100_000 }));
    expect(output.dedupedParts).toBe(0);
  });

  it('leaves the most recent messages byte-identical', () => {
    const input = conversation();
    const output = compressRequest(input, settings());
    expect(output.request.messages.at(-1)).toBe(input.messages.at(-1));
    expect(output.request.messages.at(-2)).toBe(input.messages.at(-2));
  });

  it('drops old reasoning only when the message keeps other content', () => {
    const output = compressRequest(conversation(), settings());
    expect(output.droppedReasoningParts).toBe(1);
    expect(output.request.messages[1]?.content.map((p) => p.type)).toEqual(['tool_call']);
    expect(output.request.messages[5]?.content.map((p) => p.type)).toEqual(['reasoning']);
    const kept = compressRequest(conversation(), settings({ dropOldReasoning: false }));
    expect(kept.request.messages[1]?.content.map((p) => p.type)).toEqual([
      'reasoning',
      'tool_call',
    ]);
  });

  it('reports exactly the characters it saved and does not mutate the input', () => {
    const input = conversation();
    const before = JSON.stringify(input);
    const output = compressRequest(input, settings());
    expect(JSON.stringify(input)).toBe(before);
    expect(output.savedChars).toBe(chars(input.messages) - chars(output.request.messages));
    expect(output.savedChars).toBeGreaterThan(0);
  });

  it('does not touch tool results that contain images', () => {
    const image: CanonicalPart = {
      type: 'tool_result',
      toolCallId: 't1',
      content: [
        { type: 'text', text: big },
        { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' } },
      ],
    };
    const input = request([
      { role: 'assistant', content: [call('t1')] },
      { role: 'tool', content: [image] },
      { role: 'user', content: [text('a')] },
      { role: 'user', content: [text('b')] },
    ]);
    expect(compressRequest(input, settings()).request).toBe(input);
  });
});

describe('truncateMiddle', () => {
  it('keeps the head and the tail', () => {
    const out = truncateMiddle(`${'H'.repeat(500)}TAIL`, 100);
    expect(out.startsWith('H'.repeat(60))).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('404 characters omitted');
    expect(truncateMiddle('short', 100)).toBe('short');
  });
});

describe('cleanToolOutput', () => {
  it('strips terminal escapes, trailing spaces, blank runs and repeated lines', () => {
    const noisy = [
      '\u001B[31mred\u001B[0m   ',
      '',
      '',
      '',
      ...Array.from({ length: 20 }, () => 'same'),
      'end',
      'x'.repeat(80),
    ].join('\n');
    const cleaned = cleanToolOutput(noisy);
    expect(cleaned).not.toContain('\u001B');
    expect(cleaned).toContain('red\n\nsame\n… [previous line repeated 19 more times]\nend');
  });

  it('removes git object hashes and modes but keeps hunks', () => {
    const diff = [
      'diff --git a/x b/x',
      'index 1234abc..5678def 100644',
      'old mode 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'pad '.repeat(30),
    ].join('\n');
    const cleaned = cleanToolOutput(diff);
    expect(cleaned).not.toContain('index 1234abc');
    expect(cleaned).not.toContain('old mode');
    expect(cleaned).toContain('@@ -1 +1 @@\n-a\n+b');
  });

  it('returns the input when cleaning would not make it shorter', () => {
    expect(cleanToolOutput('short')).toBe('short');
    const plain = Array.from({ length: 10 }, (_, i) => `distinct line number ${String(i)}`).join(
      '\n',
    );
    expect(cleanToolOutput(plain)).toBe(plain);
  });
});

describe('evaluation set (test-fixtures/compression)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../test-fixtures/compression');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

  it('contains at least one conversation', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    it(`${name}: structure is preserved and the request is still valid`, () => {
      const input = CanonicalRequest.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      const output = compressRequest(
        input,
        settings({ maxToolResultChars: 2_000, keepRecentMessages: 4 }),
      );
      expect(verifyStructure(input.messages, output.request.messages)).toBe(true);
      expect(CanonicalRequest.safeParse(output.request).success).toBe(true);
      const before = chars(input.messages);
      const after = chars(output.request.messages);
      expect(output.savedChars).toBe(before - after);
      // Every call still has its result and vice versa.
      const ids = (type: 'tool_call' | 'tool_result') =>
        output.request.messages
          .flatMap((m) => m.content)
          .flatMap((p) => (p.type === type ? [p.type === 'tool_call' ? p.id : p.toolCallId] : []))
          .sort();
      expect(ids('tool_result')).toEqual(ids('tool_call'));
      // eslint-disable-next-line no-console -- the saving ratio is the point of the evaluation
      console.log(
        `compression ${name}: ${String(before)} -> ${String(after)} chars (${String(
          Math.round((1 - after / Math.max(1, before)) * 100),
        )}% saved)`,
      );
    });
  }
});
