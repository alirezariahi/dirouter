/**
 * Edge cases of the sprint 5 translation helpers (cards 31.2, 31.4 and 31.7): every citation
 * location, malformed input, and every refusal.
 */
import type { CanonicalPart, CanonicalRequest } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicCitationIn,
  anthropicCitationOut,
  anthropicServerToolsOut,
  applyParamPolicy,
  applyPatchOperationOf,
  codingCallIn,
  codingOutputItem,
  codingToolIn,
  geminiCitationsIn,
  geminiLogprobsIn,
  geminiServerToolIn,
  openAIAnnotationsIn,
  openAILogprobsIn,
  refuseServerTools,
  responsesServerToolIn,
  UnsupportedContentError,
} from './index.js';

describe('Anthropic citation locations', () => {
  it.each([
    [
      {
        type: 'page_location',
        cited_text: 'p',
        document_index: 1,
        start_page_number: 2,
        end_page_number: 3,
      },
      { kind: 'document', documentIndex: 1, citedText: 'p', location: 'page', from: 2, to: 3 },
      'page_location',
    ],
    [
      {
        type: 'content_block_location',
        cited_text: 'b',
        document_index: 0,
        start_block_index: 0,
        end_block_index: 1,
      },
      { kind: 'document', documentIndex: 0, citedText: 'b', location: 'block', from: 0, to: 1 },
      'content_block_location',
    ],
    [
      {
        type: 'search_result_location',
        cited_text: 's',
        search_result_index: 2,
        title: 'T',
        source: 'x',
        start_block_index: 1,
        end_block_index: 2,
      },
      {
        kind: 'document',
        documentIndex: 2,
        documentTitle: 'T',
        citedText: 's',
        location: 'block',
        from: 1,
        to: 2,
      },
      'content_block_location',
    ],
  ])('%#', (raw, canonical, outType) => {
    const citation = anthropicCitationIn(raw);
    expect(citation).toEqual(canonical);
    expect(citation && anthropicCitationOut(citation).type).toBe(outType);
  });

  it('ignores what it cannot read', () => {
    expect(anthropicCitationIn(null)).toBeUndefined();
    expect(anthropicCitationIn({ type: 'future_location' })).toBeUndefined();
    expect(anthropicCitationIn({ type: 'web_search_result_location' })).toBeUndefined();
    expect(anthropicCitationIn({ type: 'char_location' })).toEqual({
      kind: 'document',
      documentIndex: 0,
      citedText: '',
      location: 'char',
      from: 0,
      to: 0,
    });
  });
});

describe('citations from OpenAI and Gemini, odd shapes', () => {
  const parts = (): CanonicalPart[] => [
    { type: 'reasoning', text: 'x' },
    { type: 'text', text: 'Hello world' },
  ];

  it('OpenAI: non-url annotations are skipped; a title is optional', () => {
    const content = parts();
    openAIAnnotationsIn(content, [
      { type: 'file_citation', file_id: 'f' },
      {
        type: 'url_citation',
        url_citation: { url: 'https://a.example', start_index: 6, end_index: 11 },
      },
      'junk',
    ]);
    expect(content[1]).toEqual({
      type: 'text',
      text: 'Hello world',
      citations: [{ kind: 'url', url: 'https://a.example', start: 6, end: 11 }],
    });
    const none = parts();
    openAIAnnotationsIn(none, undefined);
    expect(none[1]).not.toHaveProperty('citations');
  });

  it('Gemini: citationMetadata, and chunks without a web source', () => {
    const content = parts();
    geminiCitationsIn(content, {
      groundingMetadata: {
        groundingChunks: [{ retrievedContext: { uri: 'x' } }],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0, 9] },
        ],
      },
      citationMetadata: {
        citations: [{ startIndex: 6, endIndex: 11, uri: 'https://b.example' }, { startIndex: 0 }],
      },
    });
    expect(content[1]).toMatchObject({
      citations: [{ kind: 'url', url: 'https://b.example', start: 6, end: 11 }],
    });
    const empty: CanonicalPart[] = [];
    geminiCitationsIn(empty, { citationMetadata: { citations: [{ uri: 'https://c.example' }] } });
    expect(empty).toEqual([]);
  });

  it('log probabilities: absent, or without alternatives', () => {
    expect(openAILogprobsIn(null)).toBeUndefined();
    expect(openAILogprobsIn({ content: [{ token: 'a' }] })).toEqual([{ token: 'a', logprob: 0 }]);
    expect(geminiLogprobsIn({})).toBeUndefined();
    expect(geminiLogprobsIn({ logprobsResult: { chosenCandidates: [{}] } })).toEqual([
      { token: '', logprob: 0 },
    ]);
  });
});

describe('coding tools, malformed input', () => {
  it('a custom tool without a grammar or a name', () => {
    expect(codingToolIn({ type: 'custom', name: 'run', format: { type: 'text' } })).toMatchObject({
      name: 'run',
      kind: 'custom',
    });
    expect(codingToolIn({ type: 'custom', name: 'run' })).not.toHaveProperty('description');
    expect(codingToolIn({ type: 'custom' })).toBeUndefined();
    expect(codingToolIn({ type: 'function', name: 'f' })).toBeUndefined();
  });

  it('replayed calls without an id or a name, or with odd fields', () => {
    expect(codingCallIn({ type: 'custom_tool_call', name: 'x' })).toBeUndefined();
    expect(codingCallIn({ type: 'custom_tool_call', call_id: 'c' })).toBeUndefined();
    expect(codingCallIn({ type: 'custom_tool_call', id: 'c', name: 'x', input: 3 })).toEqual({
      type: 'tool_call',
      id: 'c',
      name: 'x',
      arguments: '{"input":""}',
    });
    expect(codingCallIn({ type: 'apply_patch_call', call_id: 'c', operation: 'x' })).toMatchObject({
      arguments: '{}',
    });
    expect(codingCallIn({ type: 'other', call_id: 'c' })).toBeUndefined();
  });

  it('apply_patch arguments that are not an operation stay a function call', () => {
    expect(applyPatchOperationOf('not json')).toBeUndefined();
    expect(applyPatchOperationOf('{"type":"rename_file","path":"a"}')).toBeUndefined();
    expect(applyPatchOperationOf('{"type":"update_file","path":"a"}')).toEqual({
      type: 'update_file',
      path: 'a',
      diff: '',
    });
    const call = { id: 'c', name: 'apply_patch', arguments: '{}' };
    expect(codingOutputItem(call, 'apply_patch', 'completed')).toBeUndefined();
    expect(codingOutputItem(call, undefined, 'completed')).toBeUndefined();
    expect(
      codingOutputItem({ ...call, arguments: 'raw text' }, 'custom', 'completed'),
    ).toMatchObject({
      input: 'raw text',
    });
  });
});

describe('server tools, every mapping and refusal', () => {
  it('options and kinds', () => {
    expect(
      anthropicServerToolsOut([
        { type: 'web_fetch', maxUses: 2, blockedDomains: ['x.example'] },
        { type: 'web_search', blockedDomains: ['y.example'] },
      ]),
    ).toEqual([
      {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 2,
        blocked_domains: ['x.example'],
      },
      { type: 'web_search_20250305', name: 'web_search', blocked_domains: ['y.example'] },
    ]);
    expect(geminiServerToolIn({ googleSearchRetrieval: {} })).toEqual({ type: 'web_search' });
    expect(geminiServerToolIn({ codeExecution: {} })).toEqual({ type: 'code_execution' });
    expect(geminiServerToolIn({ functionDeclarations: [] })).toBeUndefined();
    expect(responsesServerToolIn({ type: 'web_search_preview' })).toEqual({ type: 'web_search' });
    expect(responsesServerToolIn({ type: 'file_search' })).toBeUndefined();
  });

  it('Bedrock refuses every server tool', () => {
    expect(() => {
      refuseServerTools({ serverTools: [{ type: 'web_search' }] }, 'Bedrock');
    }).toThrow(UnsupportedContentError);
    expect(() => {
      refuseServerTools({}, 'Bedrock');
    }).not.toThrow();
  });
});

describe('parameter policy, type checks', () => {
  const request: CanonicalRequest = {
    inboundApi: 'openai.chat',
    model: 'm',
    system: [],
    messages: [],
    stream: false,
  };
  const target = { dropParams: true, target: "model 'm'" };

  it.each([
    ['top_p', 'x', 'a number'],
    ['top_k', 1.5, 'an integer'],
    ['seed', '1', 'an integer'],
    ['max_tokens', -1, 'a non-negative integer'],
    ['stop', [1], 'a string or a list of strings'],
    ['parallel_tool_calls', 'yes', 'true or false'],
  ])('%s', (name, value, expected) => {
    expect(() => applyParamPolicy(request, { overrides: { [name]: value } }, target)).toThrow(
      `'${name}' must be ${expected}`,
    );
  });

  it('portable values are set and cleared', () => {
    const { request: set } = applyParamPolicy(
      { ...request, topP: 0.1, seed: 1, parallelToolCalls: true, reasoning: { effort: 'low' } },
      {
        overrides: { top_p: 0.5, top_k: 3, max_completion_tokens: 9, parallel_tool_calls: false },
        drop: ['seed', 'reasoning_effort'],
      },
      target,
    );
    expect(set).toMatchObject({ topP: 0.5, topK: 3, maxOutputTokens: 9, parallelToolCalls: false });
    expect(set.seed).toBeUndefined();
    expect(set.reasoning).toBeUndefined();
    const { request: effort } = applyParamPolicy(
      request,
      { defaults: { reasoning_effort: 'high' } },
      target,
    );
    expect(effort.reasoning).toEqual({ effort: 'high' });
  });
});
