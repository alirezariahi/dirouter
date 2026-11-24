[English](anthropic.md) · [فارسی](anthropic.fa.md)

<div dir="rtl">

# Anthropic

- `type: anthropic`، `baseUrl: https://api.anthropic.com`
- هدرها: `x-api-key`، `anthropic-version` (پیش‌فرض `2023-06-01` یا `options.version`)
- `anthropic-beta`:
  - `options.betas`: betaهای ثابت که همیشه فرستاده می‌شوند
  - `options.allowedBetas`: betaهایی که کلاینت Anthropic (مثلاً Claude Code) مجاز است بفرستد؛ `["*"]` یعنی همه. از کلاینت OpenAI هرگز beta عبور نمی‌کند.
- prompt caching (`cache_control` همراه با `ttl`) روی بلوک‌های system، ابزارها، متن، تصویر، سند، `tool_use` و `tool_result` حفظ می‌شود (کارت ۲۷.۳)؛ thinking امضاشده و server toolها برای کلاینت Anthropic دست‌نخورده عبور می‌کنند.
- `response_format` (کارت ۲۷.۱): مدل‌های دارای structured output بومی `output_config.format` می‌گیرند؛ مدل‌های قدیمی‌تر ابزار اجباری `dirouter_structured_output` می‌گیرند و فراخوانی آن به‌صورت متن JSON به کلاینت برمی‌گردد. `options.structuredOutput` (`native` یا `tool`) این انتخاب را عوض می‌کند. جزئیات: [ترجمه](../gateway/translation.fa.md#structured-output).
- usage: `cache_read_input_tokens` و `cache_creation_input_tokens` ثبت می‌شوند (inputTokens کل = input + cache read + cache write).
- خطا: `overloaded_error` (529) و `api_error` (500) قابل retry و فال‌بک‌اند.

## Claude Code از طریق DiRouter (کارت ۴.۷)

- هدرهای `anthropic-version` و `anthropic-beta` کلاینت با فهرست مجاز (`allowedBetas`) به upstream می‌روند.
- `cache_control` و `thinking` بدون تغییر می‌روند.
- usage شامل cache read/write است: `input_tokens` در Anthropic شامل cache نیست؛ در canonical جمع می‌شود.
- خطای `overloaded_error` (529) کلاس `overloaded` می‌گیرد: retryable با فال‌بک.

بررسی در compose (۲۰۲۶-۱۱-۰۷): Claude Code 2.1.285 با `ANTHROPIC_BASE_URL=http://api.localhost` و alias `claude-sonnet-4-5` به provider نوع `anthropic` (mock-anthropic) وصل شد. stream موفق بود و tool_use و tool_result در هر دو جهت رفت و برگشتند (جزئیات در [api/gateway.md](../api/gateway.fa.md)).

⏳ تست با Anthropic واقعی نیاز به یک کلید API دارد: یک provider نوع `anthropic` با کلید واقعی بسازید و alias `claude-sonnet-4-5` را به آن ببرید.

</div>
