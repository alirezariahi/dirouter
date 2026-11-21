[English](jina.md) · [فارسی](jina.fa.md)

<div dir="rtl">

# Jina AI (کارت ۱۱.۴)

| فیلد       | مقدار                         |
| ---------- | ----------------------------- |
| type       | `jina`                        |
| baseUrl    | `https://api.jina.ai/v1`      |
| امبدینگ    | `POST /embeddings`            |
| چت         | پشتیبانی نمی‌شود              |
| احراز هویت | `Authorization: Bearer <key>` |

## نگاشت canonical → Jina

- `texts[]` → `input[]`
- `dimensions` → `dimensions`
- پاسخ: `data[].embedding` بر اساس `index` مرتب می‌شود و usage از `usage.total_tokens`.

## پیکربندی نمونه

```json
{
  "type": "jina",
  "name": "Jina",
  "baseUrl": "https://api.jina.ai/v1",
  "credentials": [{ "name": "prod", "secret": "jina_..." }]
}
```

مدل‌ها: `jina-embeddings-v3`، `jina-embeddings-v4`، `jina-clip-v2` و…

مانند Voyage، درخواست chat روی این provider خطای `Jina AI only supports embeddings` می‌دهد و fallback فعال می‌شود.

تست: `packages/providers/src/native.test.ts`.

</div>
