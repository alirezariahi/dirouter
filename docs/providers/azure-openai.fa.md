[English](azure-openai.md) · [فارسی](azure-openai.fa.md)

<div dir="rtl">

# Azure OpenAI

- `type: azure-openai`، `baseUrl: https://<resource>.openai.azure.com`
- `upstreamModel` هر مدل = **نام deployment**
- `options.apiVersion` (پیش‌فرض `2024-10-21`)
- احراز هویت به‌طور پیش‌فرض با هدر `api-key`؛ فیلد `model` در بدنه فرستاده نمی‌شود
- فیلد سقف خروجی: `max_completion_tokens`

## client credentials در Entra ID (کارت ۲۷.۴)

`options.authMode: "entra"` را بگذارید و app registration را به‌صورت JSON در secret همان credential ذخیره کنید:

```json
{ "tenantId": "<tenant id or domain>", "clientId": "<application id>", "clientSecret": "<secret>" }
```

secret مثل بقیهٔ credentialها با `MASTER_KEY` رمز می‌شود. گیت‌وی از grant نوع client credentials نسخهٔ ۲ در Entra ID استفاده می‌کند (`POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` با scope `https://cognitiveservices.azure.com/.default`)، access token را برای هر credential کش و پیش از انقضا تمدید می‌کند و آن را به‌جای `api-key` به‌صورت `Authorization: Bearer …` می‌فرستد. app registration روی resource به نقش _Cognitive Services OpenAI User_ نیاز دارد.

| گزینه                   | معنا                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `options.authorityHost` | authority برای ابرهای مستقل (پیش‌فرض `https://login.microsoftonline.com`) |
| `options.tokenUrl`      | آدرس کامل توکن که authority را کنار می‌گذارد (endpoint خصوصی یا سرور تست) |
| `options.scope`         | scope (پیش‌فرض `https://cognitiveservices.azure.com/.default`)            |

شکست مبادلهٔ توکن **فقط همان credential** را به cooldown می‌برد (با backoff نمایی)، نه کل provider را: credentialهای دیگر کار می‌کنند و circuit breaker دست نمی‌خورد. تا وقتی توکن کش‌شده معتبر است، شکست تمدید ترافیک را قطع نمی‌کند. سرویس‌اکانت Vertex هم از همین سازوکار استفاده می‌کند؛ [vertex](vertex.fa.md) را ببینید.

</div>
