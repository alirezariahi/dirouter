/** Prompt-prefix session identity for sticky combos without a session header (card 12.4). */
import { describe, expect, it } from 'vitest';

import { promptPrefixSessionKey } from './proxy.js';

const text = (value: string) => ({ type: 'text', text: value });
const user = (value: string) => ({ role: 'user', content: [text(value)] });
const assistant = (value: string) => ({ role: 'assistant', content: [text(value)] });

describe('promptPrefixSessionKey', () => {
  const system = [text('You are a coding agent.')];

  it('stays the same while a conversation grows', () => {
    const first = promptPrefixSessionKey('key1', { system, messages: [user('fix the bug')] });
    const later = promptPrefixSessionKey('key1', {
      system,
      messages: [user('fix the bug'), assistant('done'), user('now add a test')],
    });
    expect(first).toBeDefined();
    expect(later).toBe(first);
  });

  it('differs per key, per system prompt and per first message', () => {
    const base = promptPrefixSessionKey('key1', { system, messages: [user('a')] });
    expect(promptPrefixSessionKey('key2', { system, messages: [user('a')] })).not.toBe(base);
    expect(
      promptPrefixSessionKey('key1', { system: [text('other')], messages: [user('a')] }),
    ).not.toBe(base);
    expect(promptPrefixSessionKey('key1', { system, messages: [user('b')] })).not.toBe(base);
  });

  it('does not pin one-off requests without a system prompt', () => {
    expect(
      promptPrefixSessionKey('key1', { system: [], messages: [user('hello')] }),
    ).toBeUndefined();
    expect(
      promptPrefixSessionKey('key1', { system: [], messages: [user('a'), assistant('b')] }),
    ).toBeDefined();
  });

  it('never contains prompt text', () => {
    const key = promptPrefixSessionKey('key1', { system, messages: [user('secret words')] });
    expect(key).toMatch(/^key1:p:[0-9a-f]{32}$/);
  });
});
