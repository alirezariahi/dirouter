---
'@dirouter/gateway': minor
'@dirouter/providers': minor
'@dirouter/mock-provider': minor
'@dirouter/contracts': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

The remaining OpenAI endpoints: `POST /v1/images/edits` and `/v1/images/variations` (multipart,
one or several images and a mask, priced per image plus gpt-image tokens), `/v1/audio/translations`
(priced per second like transcriptions) and the legacy `/v1/completions`. Completions are sent
natively to models with the new `completions` capability (instruct models, Azure, vLLM) and mapped
to chat for every other model and provider type; options chat cannot express are refused with a
clear 400, and `stream: true` is answered in the completion chunk format. All four work with the
official SDK and record their cost (`inboundApi` `openai.images`, `openai.translations`,
`openai.completions`). The mock provider serves the new endpoints.
