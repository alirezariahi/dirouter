/**
 * Card 27.2: documents (PDF, text, files) and audio between OpenAI, Responses, Anthropic and
 * Gemini, and clear errors for what a destination cannot carry.
 */
import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  GeminiGenerateContentRequest,
  OpenAIChatCompletionRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  UnsupportedContentError,
  anthropicRequestToCanonical,
  canonicalToAnthropicRequest,
  canonicalToGeminiRequest,
  canonicalToOpenAIRequest,
  geminiRequestToCanonical,
  mediaNeeds,
  openAIRequestToCanonical,
  responsesRequestToCanonical,
} from './index.js';

/** "%PDF-1.4" in base64, enough to stand for a file. */
const PDF = 'JVBERi0xLjQ=';
const WAV = 'UklGRiQAAABXQVZF';

const fromOpenAI = (content: unknown[]) =>
  openAIRequestToCanonical(
    OpenAIChatCompletionRequest.parse({ model: 'm', messages: [{ role: 'user', content }] }),
  );
const fromAnthropic = (content: unknown[]) =>
  anthropicRequestToCanonical(
    AnthropicMessagesRequest.parse({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content }],
    }),
  );
const fromGemini = (parts: unknown[]) =>
  geminiRequestToCanonical(
    GeminiGenerateContentRequest.parse({ contents: [{ role: 'user', parts }] }),
    { model: 'gemini-2.5-flash' },
  );

const toAnthropic = (req: CanonicalRequest) => {
  const body = canonicalToAnthropicRequest(req, { upstreamModel: 'claude-sonnet-4-5' });
  expect(AnthropicMessagesRequest.safeParse(body).success).toBe(true);
  return (body.messages as { content: unknown[] }[])[0]?.content;
};
const toOpenAI = (req: CanonicalRequest) => {
  const body = canonicalToOpenAIRequest(req, { upstreamModel: 'gpt-4.1' });
  expect(OpenAIChatCompletionRequest.safeParse(body).success).toBe(true);
  return (body.messages as { content: unknown }[])[0]?.content;
};
const toGemini = (req: CanonicalRequest) =>
  (
    canonicalToGeminiRequest(req, {}).contents as {
      parts: unknown[];
    }[]
  )[0]?.parts;

const openAIPdf = [
  { type: 'text', text: 'Summarize' },
  {
    type: 'file',
    file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF}` },
  },
];

describe('golden: a PDF from an OpenAI client', () => {
  it('becomes an Anthropic document block', () => {
    expect(toAnthropic(fromOpenAI(openAIPdf))).toEqual([
      { type: 'text', text: 'Summarize' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
    ]);
  });

  it('becomes Gemini inlineData', () => {
    expect(toGemini(fromOpenAI(openAIPdf))).toEqual([
      { text: 'Summarize' },
      { inlineData: { mimeType: 'application/pdf', data: PDF } },
    ]);
  });

  it('goes back to an OpenAI provider unchanged', () => {
    expect(toOpenAI(fromOpenAI(openAIPdf))).toEqual(openAIPdf);
  });

  it('bare base64 takes its media type from the file name', () => {
    const req = fromOpenAI([{ type: 'file', file: { filename: 'notes.txt', file_data: 'aGk=' } }]);
    expect(req.messages[0]?.content[0]).toEqual({
      type: 'document',
      source: { kind: 'base64', mediaType: 'text/plain', data: 'aGk=' },
      filename: 'notes.txt',
    });
    // Anthropic reads plain text as a text source.
    expect(toAnthropic(req)).toEqual([
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hi' } },
    ]);
  });
});

describe('golden: a PDF from an Anthropic client', () => {
  const block = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: PDF },
    title: 'Q3 report',
    context: 'from finance',
    citations: { enabled: true },
  };

  it('reaches an OpenAI provider as a file part', () => {
    expect(toOpenAI(fromAnthropic([block, { type: 'text', text: 'Summarize' }]))).toEqual([
      {
        type: 'file',
        file: { filename: 'Q3 report.pdf', file_data: `data:application/pdf;base64,${PDF}` },
      },
      { type: 'text', text: 'Summarize' },
    ]);
  });

  it('reaches Gemini as inlineData, and a URL document as fileData', () => {
    expect(toGemini(fromAnthropic([block]))).toEqual([
      { inlineData: { mimeType: 'application/pdf', data: PDF } },
    ]);
    const byUrl = fromAnthropic([
      { type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } },
    ]);
    expect(toGemini(byUrl)).toEqual([
      { fileData: { mimeType: 'application/pdf', fileUri: 'https://x.test/a.pdf' } },
    ]);
  });

  it('round-trips to Anthropic with title, context and citations', () => {
    expect(toAnthropic(fromAnthropic([block]))).toEqual([block]);
  });

  it('text and content sources become text for OpenAI and Gemini', () => {
    const req = fromAnthropic([
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'body' } },
      {
        type: 'document',
        title: 'Notes',
        source: { type: 'content', content: [{ type: 'text', text: 'one' }] },
      },
    ]);
    expect(toOpenAI(req)).toEqual([
      { type: 'text', text: 'body' },
      { type: 'text', text: 'Notes\n\none' },
    ]);
    expect(toGemini(req)).toEqual([{ text: 'body' }, { text: 'one' }]);
  });
});

describe('golden: documents and audio from a Gemini client', () => {
  it('a PDF reaches Anthropic and OpenAI', () => {
    const req = fromGemini([
      { inlineData: { mimeType: 'application/pdf', data: PDF } },
      { text: 'Summarize' },
    ]);
    expect(toAnthropic(req)?.[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF },
    });
    expect(toOpenAI(req)).toEqual([
      {
        type: 'file',
        file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF}` },
      },
      { type: 'text', text: 'Summarize' },
    ]);
  });

  it('inline audio reaches OpenAI as input_audio, images stay images', () => {
    const req = fromGemini([
      { inlineData: { mimeType: 'audio/mpeg', data: WAV } },
      { inlineData: { mimeType: 'image/png', data: 'iVBO' } },
    ]);
    expect(req.messages[0]?.content.map((p) => p.type)).toEqual(['audio', 'image']);
    expect(toOpenAI(req)).toEqual([
      { type: 'input_audio', input_audio: { data: WAV, format: 'mp3' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } },
    ]);
  });

  it('a file URI keeps its media type', () => {
    const req = fromGemini([
      { fileData: { mimeType: 'audio/wav', fileUri: 'gs://bucket/a.wav' } },
      { fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/a.pdf' } },
    ]);
    expect(toGemini(req)).toEqual([
      { fileData: { mimeType: 'audio/wav', fileUri: 'gs://bucket/a.wav' } },
      { fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/a.pdf' } },
    ]);
  });
});

describe('golden: audio from an OpenAI client', () => {
  const audio = [{ type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }];

  it('reaches Gemini as inlineData and OpenAI unchanged', () => {
    expect(toGemini(fromOpenAI(audio))).toEqual([
      { inlineData: { mimeType: 'audio/wav', data: WAV } },
    ]);
    expect(toOpenAI(fromOpenAI(audio))).toEqual(audio);
  });

  it('is refused by Anthropic with a clear error', () => {
    expect(() => toAnthropic(fromOpenAI(audio))).toThrow(UnsupportedContentError);
    expect(() => toAnthropic(fromOpenAI(audio))).toThrow(/Claude has no audio input/);
  });
});

describe('golden: Responses input_file', () => {
  const responses = (part: { type: string } & Record<string, unknown>) =>
    responsesRequestToCanonical({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [part] }],
    });

  it('file_data reaches Anthropic and Gemini', () => {
    const req = responses({
      type: 'input_file',
      filename: 'a.pdf',
      file_data: `data:application/pdf;base64,${PDF}`,
    });
    expect(toAnthropic(req)).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
    ]);
    expect(toGemini(req)).toEqual([{ inlineData: { mimeType: 'application/pdf', data: PDF } }]);
  });

  it('file_url and file_id are kept as a URL and an OpenAI file id', () => {
    expect(
      responses({ type: 'input_file', file_url: 'https://x.test/b.pdf' }).messages[0]?.content,
    ).toEqual([
      {
        type: 'document',
        source: { kind: 'url', url: 'https://x.test/b.pdf', mediaType: 'application/pdf' },
      },
    ]);
    const byId = responses({ type: 'input_file', file_id: 'file-1' });
    expect(toOpenAI(byId)).toEqual([{ type: 'file', file: { file_id: 'file-1' } }]);
  });
});

describe('unsupported content is an error, not a silent drop', () => {
  it.each([
    [
      'URL document to OpenAI',
      () =>
        toOpenAI(fromAnthropic([{ type: 'document', source: { type: 'url', url: 'https://x' } }])),
      /files by URL are not accepted/,
    ],
    [
      'Word document to OpenAI',
      () =>
        toOpenAI(fromGemini([{ inlineData: { mimeType: 'application/msword', data: 'AAAA' } }])),
      /only PDF files are accepted/,
    ],
    [
      'Word document to Anthropic',
      () =>
        toAnthropic(fromGemini([{ inlineData: { mimeType: 'application/msword', data: 'AAAA' } }])),
      /only PDF and plain-text documents/,
    ],
    [
      'OpenAI file id to Anthropic',
      () => toAnthropic(fromOpenAI([{ type: 'file', file: { file_id: 'file-1' } }])),
      /openai file id is not valid here/,
    ],
    [
      'Anthropic file id to Gemini',
      () => toGemini(fromAnthropic([{ type: 'document', source: { type: 'file', file_id: 'f' } }])),
      /anthropic file id is not valid here/,
    ],
    [
      'flac audio to OpenAI',
      () => toOpenAI(fromGemini([{ inlineData: { mimeType: 'audio/flac', data: 'AAAA' } }])),
      /only wav and mp3/,
    ],
  ])('%s', (_name, run, message) => {
    expect(run).toThrow(UnsupportedContentError);
    expect(run).toThrow(message);
  });

  it('the error names the field', () => {
    expect.assertions(1);
    try {
      toAnthropic(fromOpenAI([{ type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }]));
    } catch (error) {
      expect((error as UnsupportedContentError).field).toBe('messages[].content[].audio');
    }
  });
});

describe('mediaNeeds', () => {
  it('reports documents and audio', () => {
    expect(mediaNeeds(fromOpenAI(openAIPdf))).toEqual({ documents: true, audio: false });
    expect(
      mediaNeeds(fromOpenAI([{ type: 'input_audio', input_audio: { data: WAV, format: 'mp3' } }])),
    ).toEqual({ documents: false, audio: true });
    expect(mediaNeeds(fromOpenAI([{ type: 'text', text: 'hi' }]))).toEqual({
      documents: false,
      audio: false,
    });
  });
});
