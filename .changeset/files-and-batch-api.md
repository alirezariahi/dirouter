---
'@dirouter/gateway': minor
'@dirouter/contracts': minor
'@dirouter/model-catalog': minor
'@dirouter/providers': minor
'@dirouter/mock-provider': minor
---

Files API and Batch API (card 30.1): `/v1/files` (upload, list, retrieve, content, delete) and `/v1/batches` (create, retrieve, cancel, list), compatible with the official OpenAI SDKs.

- A batch runs on the provider's own batch API: OpenAI (and OpenAI-compatible providers with `options.batch`) or Anthropic Message Batches, whose results are translated back to chat completions.
- The key's rate limit and budgets apply at creation, the wallet holds the worst case, and one usage event at completion bills the summed usage at the catalog's `batchDiscount`.
- Files and batches belong to the organization that created them; other organizations get 404.
- Bytes are kept on a local volume or an S3-compatible bucket (`FILES_STORAGE` and `FILES_S3_*`), with an upload cap and retention; state lives in Valkey and a job poller in the gateway follows running batches (ADR-0007).
- The mock provider serves OpenAI files and batches and Anthropic message batches.
