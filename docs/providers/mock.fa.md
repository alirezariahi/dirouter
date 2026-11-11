[English](mock.md) · [فارسی](mock.fa.md)

<div dir="rtl">

# DiRouter mock

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai-compatible`              |
| options.preset               | `mock`                           |
| baseUrl پیش‌فرض              | `http://mock-provider:8090/v1`   |
| فیلد سقف خروجی               | `max_tokens`                     |
| stream_options.include_usage | `پشتیبانی می‌شود`                |
| کلید API                     | `الزامی (Authorization: Bearer)` |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

</div>
