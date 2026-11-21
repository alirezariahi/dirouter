[English](voyage.md) · [فارسی](voyage.fa.md)

<div dir="rtl">

# Voyage AI (کارت ۱۱.۴)

| فیلد       | مقدار                         |
| ---------- | ----------------------------- |
| type       | `voyage`                      |
| baseUrl    | `https://api.voyageai.com/v1` |
| امبدینگ    | `POST /embeddings`            |
| چت         | پشتیبانی نمی‌شود              |
| احراز هویت | `Authorization: Bearer <key>` |

## نگاشت canonical → Voyage

- `texts[]` → `input[]`
- `dimensions` → `output_dimension`
- `input_type: "document"` (برای امبدینگ اسناد؛ در آینده می‌تواند query هم باشد)
- پاسخ: `data[].embedding` بر اساس `index` مرتب می‌شود و usage از `usage.total_tokens`.

## پیکربندی نمونه

```json
{
  "type": "voyage",
  "name": "Voyage",
  "baseUrl": "https://api.voyageai.com/v1",
  "credentials": [{ "name": "prod", "secret": "pa-..." }]
}
```

مدل‌ها: `voyage-3`، `voyage-3-lite`، `voyage-code-3`، `voyage-multilingual-2` و…

اگر مدل chat با این provider انتخاب شود، خطای `Voyage AI only supports embeddings` برمی‌گردد و combo به کاندیدای بعدی fallback می‌کند.

تست: `packages/providers/src/native.test.ts`.

</div>
