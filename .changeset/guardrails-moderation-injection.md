---
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/providers': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/mock-provider': minor
---

New `moderation` guardrail: an OpenAI-compatible moderation model or a Llama Guard chat model judges requests and answers through the gateway, with per-category thresholds, a timeout and fail-open or fail-closed (card 23.2). `POST /v1/moderations` is served. Prompt-injection detection has English and Persian patterns measured on a labelled set of 100 samples and an optional classifier model (card 23.3).
