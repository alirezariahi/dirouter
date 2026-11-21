[English](voyage.md) · [فارسی](voyage.fa.md)

# Voyage AI (card 11.4)

| Field          | Value                         |
| -------------- | ----------------------------- |
| type           | `voyage`                      |
| baseUrl        | `https://api.voyageai.com/v1` |
| embeddings     | `POST /embeddings`            |
| chat           | not supported                 |
| authentication | `Authorization: Bearer <key>` |

## canonical → Voyage mapping

- `texts[]` → `input[]`
- `dimensions` → `output_dimension`
- `input_type: "document"` (document embeddings; a query mode can be added later)
- Response: `data[].embedding` sorted by `index`; usage comes from `usage.total_tokens`.

## Example configuration

```json
{
  "type": "voyage",
  "name": "Voyage",
  "baseUrl": "https://api.voyageai.com/v1",
  "credentials": [{ "name": "prod", "secret": "pa-..." }]
}
```

Models: `voyage-3`, `voyage-3-lite`, `voyage-code-3`, `voyage-multilingual-2`, and others.

Selecting a chat model on this provider returns `Voyage AI only supports embeddings` and the combo falls back to the next candidate.

Test: `packages/providers/src/native.test.ts`.
