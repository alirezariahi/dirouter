# Image edits, audio translation and legacy completions (card 30.4)

The remaining OpenAI endpoints that tools still call. They run through the same pipeline as every
other request (virtual key, routing with fallback, rate limits, budgets, the prepaid wallet, the
key's concurrency cap) and each call is a usage event priced with the model's prices.

| Endpoint                      | Body      | Served by models with                              | Billed as                                          | `inboundApi`          |
| ----------------------------- | --------- | -------------------------------------------------- | -------------------------------------------------- | --------------------- |
| `POST /v1/images/edits`       | multipart | `images`, provider openai/compatible               | per image delivered + the tokens gpt-image reports | `openai.images`       |
| `POST /v1/images/variations`  | multipart | `images`, provider openai/compatible               | per image delivered                                | `openai.images`       |
| `POST /v1/audio/translations` | multipart | `transcription`, provider openai/compatible        | per second of audio (+ reported tokens)            | `openai.translations` |
| `POST /v1/completions`        | JSON      | any chat model (mapped), or `completions` (native) | tokens                                             | `openai.completions`  |

```ts
import OpenAI, { toFile } from 'openai';
const client = new OpenAI({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com/v1',
});

await client.images.edit({
  model: 'openai/gpt-image-1',
  image: await toFile(png, 'a.png'),
  prompt: 'add a hat',
});
await client.images.createVariation({
  model: 'openai/dall-e-2',
  image: await toFile(png, 'a.png'),
  n: 2,
});
await client.audio.translations.create({
  model: 'openai/whisper-1',
  file: await toFile(wav, 'a.wav'),
});
await client.completions.create({ model: 'openai/gpt-4.1-mini', prompt: 'Say hi', max_tokens: 20 });
```

## Image edits and variations

- `image` takes one file, or several as `image[]` (up to 16, gpt-image models); `mask` is
  optional. A variation takes exactly one image and no prompt.
- `n` from 1 to 10, `size` (`WxH` or `auto`), `quality`, `background`, `input_fidelity` and
  `output_format` are passed on.
- `response_format`: `url` or `b64_json`. Left out, each image keeps the form the provider gave,
  as OpenAI does (gpt-image answers in base64, dall-e with URLs). Asking for the other form makes
  the gateway convert it (a provider URL is downloaded; base64 becomes a data URL).
- The wallet reserves the worst case before the call: the prompt plus 6,240 tokens per uploaded
  image in, 6,240 tokens per image out, and the per-image price.
- The whole multipart body is limited to 26 MB.

## Audio translations

Speech in any language to English text, with the same formats and pricing as transcriptions
(`json`, `text`, `srt`, `vtt`, `verbose_json` with `task: "translate"`). `language` is not sent:
the source language is detected. Whisper models are asked for `verbose_json` so the duration is
exact; without it the length comes from the WAV header or is estimated from the size.

## Legacy completions

A model is called natively when its `completions` capability is on (set it for OpenAI's instruct
models, Azure instruct deployments, vLLM and other servers that still have the endpoint) and its
provider is `openai`, `openai-compatible`, `azure-openai` or `mock`. Every option passes through
(`echo`, `logprobs`, `suffix`, `best_of`, `n`, several prompts, token prompts).

Every other model (any provider type, Anthropic and Gemini included) is reached by mapping the
request to chat: the prompt becomes one user message; `max_tokens` (16 when left out, as in the
API), `temperature`, `top_p`, `stop`, `seed`, the penalties, `logit_bias` and `user` are carried
over; the answer's text and finish reason come back as the completion. What chat cannot express
is refused with a 400 naming it, never dropped: `echo`, `logprobs`, `suffix`, `best_of` > 1,
`n` > 1, several prompts and token prompts. In a combo only the targets that can serve the
request are tried.

`stream: true` is answered as server-sent events in the completion chunk format: the upstream
answer is read whole, then each choice is sent as one chunk, followed by the usage chunk when
`stream_options.include_usage` is set, and `data: [DONE]`. Clients and the SDK's stream iterator
work unchanged; the text arrives at once rather than token by token.

## Tests

- `apps/gateway/src/legacy-endpoints.test.ts`: all four endpoints with the official SDK
  (`openai` 7), checking the answer and the usage event's cost: edits with one image, several and
  a mask, variations, translations in three formats, native completions (OpenAI and Azure),
  mapped completions (OpenAI-compatible and Anthropic), streaming, and the refusals.
- `packages/providers/src/media.test.ts`, `packages/providers/src/completions.test.ts` and
  `apps/mock-provider/src/legacy.test.ts`.
- `scripts/e2e/sprint-5/30.4.mjs`: the same through Traefik, checked in `request_log`.
