---
'@dirouter/gateway': minor
'@dirouter/contracts': minor
'@dirouter/model-catalog': minor
'@dirouter/providers': minor
'@dirouter/mock-provider': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Rerank endpoint (card 30.2): `POST /v1/rerank` and `/v2/rerank` accept Cohere's and Jina's formats, so the Cohere SDKs work by changing the base URL. Adapters for Cohere, Voyage AI, Jina AI and OpenAI-compatible rerank servers; a model offers rerank with the new `rerank` capability. Requests run through the shared metered pipeline (rate limits, budgets, wallet, usage) and are priced per token at the input price or per search unit at the new `perSearchUsd` price (`search_price` column), shown in the dashboard's model form. The mock provider answers rerank requests.
