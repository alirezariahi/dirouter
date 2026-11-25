[English](batch.md) · [فارسی](batch.fa.md)

# Files API and Batch API (card 30.1)

DiRouter serves OpenAI's Files API and Batch API. A batch runs on the provider's own batch API at the provider's batch price, with the same virtual key, budgets, wallet and usage accounting as any other request. The official OpenAI SDKs work by changing `baseURL` only.

| Endpoint                       | What it does                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `POST /v1/files`               | Upload (`multipart/form-data`: `file`, `purpose`, `expires_after`)           |
| `GET /v1/files`                | List (`purpose`, `limit` up to 10,000, `after`, `order`)                     |
| `GET /v1/files/{id}`           | File object                                                                  |
| `GET /v1/files/{id}/content`   | The bytes                                                                    |
| `DELETE /v1/files/{id}`        | Delete bytes and record                                                      |
| `POST /v1/batches`             | Create (`input_file_id`, `endpoint`, `completion_window: "24h"`, `metadata`) |
| `GET /v1/batches/{id}`         | Batch object; also refreshes its status from the provider                    |
| `POST /v1/batches/{id}/cancel` | Cancel at the provider                                                       |
| `GET /v1/batches`              | List (`limit` up to 100, `after`)                                            |

## Example

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key=DIROUTER_KEY)
batch_input = client.files.create(file=open("requests.jsonl", "rb"), purpose="batch")
batch = client.batches.create(
    input_file_id=batch_input.id,
    endpoint="/v1/chat/completions",
    completion_window="24h",
)
# … later
batch = client.batches.retrieve(batch.id)
if batch.status == "completed":
    print(client.files.content(batch.output_file_id).text)
```

Each line of the input file is `{"custom_id": "…", "method": "POST", "url": "/v1/chat/completions", "body": {…}}`. Every line must call the batch's `endpoint` and use the **same model** (a DiRouter model name, alias or combo the key may use); `custom_id` must be unique; at most 50,000 lines. Streaming is not allowed in a batch.

## Which provider runs a batch

The model is routed like a normal request with the caller's key; the first target whose provider has a batch API for the endpoint runs the whole batch:

| Provider type                                                 | Endpoints                                                                    | How                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai` (and `openai-compatible` with `options.batch: true`) | `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses`, `/v1/completions` | The input is uploaded with `purpose=batch`, model names rewritten to the upstream model, then `POST /batches`. Output and error files are downloaded. |
| `anthropic`                                                   | `/v1/chat/completions`                                                       | Each line is translated to Messages parameters and sent to `POST /v1/messages/batches`; results are translated back to chat completions.              |

A target whose provider rejects the batch with a server error or rate limit is skipped for the next one; a 400 is returned to the client. A model with no batch-capable target answers 400. Once started, a batch stays on its provider; it is not moved.

When the batch ends, DiRouter downloads the results and stores them as new files of the organization (`purpose: "batch_output"`): `output_file_id` holds successful lines and `error_file_id` failed ones, in OpenAI's batch output format (`{id, custom_id, response: {status_code, request_id, body}, error}`). The `model` in each response body is the name the client asked for.

## Price, budget and wallet

- **At creation** the key's rate limit counts one request, its budgets must have room, and a prepaid wallet holds the batch's worst case (every line's input estimate plus its `max_tokens`, or the model's output cap, or 4,096 tokens) at the batch price of the most expensive target. The hold lasts 25 hours.
- **At completion** one usage event (`inboundApi: "openai.batches"`, `requestId` = the batch id) carries the summed usage of all successful lines. Its cost is the normal token cost times `1 − batchDiscount` (from the catalog or the model's price settings, card 27.5); the sale price (multipliers, customer group) is discounted the same way. The wallet hold becomes that charge and the worker posts it to the ledger like any request.
- A batch that fails or is cancelled before any line succeeds records an error event with zero cost and releases the hold. A cancelled or expired batch is charged for the lines that did run.

## Webhook

Add `webhook_url` (a DiRouter extension) when creating a batch to receive a signed `batch.completed`, `batch.failed`, `batch.cancelled` or `batch.expired` event when it ends; see [webhooks](videos.md#webhooks).

## Isolation and retention

- A file or batch belongs to the organization of the key that created it. Every key of that organization can use it; a key of another organization gets 404, the same answer as for an id that does not exist, and never sees it in a list.
- Bytes are kept on a local volume or an S3-compatible bucket (`FILES_STORAGE`, [environment reference](../env-reference.md)), under `<organization>/<file id>`. Uploads are capped by `FILES_MAX_BYTES` (100 MB by default).
- Files are deleted after `FILES_RETENTION_DAYS` (30 by default) or earlier when the upload set `expires_after` (`anchor: created_at`, 3,600 to 2,592,000 seconds). Batch records are kept 31 days.

## How it runs

Records live in Valkey and a job poller in every gateway replica follows running batches at the provider every `JOBS_POLL_INTERVAL_MS` (15 s by default); retrieving a batch also refreshes it. Each step is locked, so several replicas never finish a batch twice. The design is recorded in [ADR-0007](../adr/0007-job-state-in-valkey.md).

Without Valkey (a single local node) the records are kept in memory and are lost on restart.

## Not supported

- Batches on providers other than OpenAI-type and Anthropic (Gemini, Bedrock and Vertex batch jobs read from their own cloud storage).
- Moving a running batch to another target when its provider fails.
- OpenAI's `/v1/uploads` multi-part upload API; files are uploaded in one request.
