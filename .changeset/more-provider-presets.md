---
'@dirouter/providers': minor
'@dirouter/gateway': minor
'@dirouter/dashboard': minor
'@dirouter/mock-provider': minor
---

Presets for more providers (card 31.6): Perplexity, DeepInfra, NVIDIA NIM, Hugging Face Inference Providers and Databricks Model Serving as OpenAI-compatible presets (with their own model-list paths), and Replicate (predictions API), IBM watsonx.ai (`text/chat` with an IAM token from the API key, `projectId`) and Amazon SageMaker (OpenAI Messages API containers, SigV4 for `sagemaker`, `ListEndpoints` discovery) as presets with their own adapters. Each has a connection test and model discovery, a contract test against the mock provider, a page under docs/providers and an entry in the dashboard's provider presets. The connection test now keeps the list request's method, so a signed POST list (SageMaker) works.
