[English](jina.md) · [فارسی](jina.fa.md)

# Jina AI (card 11.4)

| Field          | Value                         |
| -------------- | ----------------------------- |
| type           | `jina`                        |
| baseUrl        | `https://api.jina.ai/v1`      |
| embeddings     | `POST /embeddings`            |
| chat           | not supported                 |
| authentication | `Authorization: Bearer <key>` |

## canonical → Jina mapping

- `texts[]` → `input[]`
- `dimensions` → `dimensions`
- Response: `data[].embedding` sorted by `index`; usage comes from `usage.total_tokens`.

## Example configuration

```json
{
  "type": "jina",
  "name": "Jina",
  "baseUrl": "https://api.jina.ai/v1",
  "credentials": [{ "name": "prod", "secret": "jina_..." }]
}
```

Models: `jina-embeddings-v3`, `jina-embeddings-v4`, `jina-clip-v2`, and others.

As with Voyage, a chat request on this provider returns `Jina AI only supports embeddings` and triggers fallback.

Test: `packages/providers/src/native.test.ts`.
