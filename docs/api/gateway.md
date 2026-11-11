# API گیت‌وی

پایه: `https://api.<DOMAIN>` (در dev: `http://api.localhost`) · کارت ۴.۹

احراز هویت با کلید مجازی، از یکی از این دو راه:

- `Authorization: Bearer dr-…` (سبک OpenAI)
- `x-api-key: dr-…` (سبک Anthropic)

| endpoint                                            | سازگار با                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /v1/chat/completions` (و `/chat/completions`) | OpenAI Chat Completions، stream و non-stream                            |
| `POST /v1/messages`                                 | Anthropic Messages، stream و non-stream                                 |
| `POST /v1/messages/count_tokens`                    | Anthropic count_tokens؛ تخمین محلی با tokenizer، بدون فراخوانی upstream |
| `GET /v1/models`                                    | مدل‌ها، aliasها و comboهای مجاز برای کلید                               |

در `model` می‌توان slug مدل، alias یا combo را داد. هر کلاینت به هر upstreamی وصل می‌شود: کلاینت OpenAI می‌تواند به Claude برود و برعکس ([translation.md](../gateway/translation.md)).

هدرهای پاسخ:

- `x-request-id`
- `x-dirouter-provider`
- `x-dirouter-model`
- `x-dirouter-attempts`
- `x-dirouter-instance`

خطاها در قالب همان API که صدا زده شده برمی‌گردند.

## مثال‌ها

```bash
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"سلام"}]}'

curl -N https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"سلام"}]}'

curl https://api.example.com/v1/messages \
  -H "x-api-key: $DIROUTER_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"سلام"}]}'

curl https://api.example.com/v1/messages/count_tokens \
  -H "x-api-key: $DIROUTER_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"سلام"}]}'

curl https://api.example.com/v1/models -H "Authorization: Bearer $DIROUTER_KEY"
```

## SDKهای رسمی (بدون تغییر کد)

```ts
import OpenAI from 'openai';
const openai = new OpenAI({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com/v1',
});

import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com',
});
```

`apps/gateway/src/sdk.test.ts` هر دو SDK را با این حالت‌ها تست می‌کند:

- non-stream و stream، به upstream OpenAI و Anthropic
- usage در stream
- tool call و رفت‌وبرگشت tool_result
- `models.list` و `countTokens`
- خطای `AuthenticationError`

## Claude Code

```bash
export ANTHROPIC_BASE_URL=https://api.example.com
export ANTHROPIC_API_KEY=$DIROUTER_KEY
claude
```

Claude Code فقط نام مدل‌های واقعی Claude را می‌پذیرد، مثل `claude-sonnet-4-5`. در DiRouter برای همین نام‌ها alias یا combo بسازید تا به هر مدلی که می‌خواهید بروند. مدل مقصد باید context window کافی داشته باشد: system prompt و ابزارهای Claude Code به‌همراه `max_tokens` چند ده هزار توکن است و router مدل کوچک‌تر را حذف می‌کند.

بررسی در compose (۲۰۲۶-۱۱-۰۷، Claude Code 2.1.285، aliasهای dev به mock):

| حالت                                                            | نتیجه                                                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude -p "say hi"` (stream)                                   | `success`؛ پاسخ از mock-anthropic                                                                                                                                                 |
| `claude -p "…"` با alias `claude-haiku-4-5` (mock با tool call) | Claude Code پاسخ `tool_use` را گرفت، `tool_result` فرستاد و حلقه را تا `--max-turns` ادامه داد. خاتمه با `error_max_turns` مورد انتظار است، چون mock همیشه tool call برمی‌گرداند. |
