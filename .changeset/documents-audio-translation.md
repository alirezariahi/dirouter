---
'@dirouter/contracts': minor
'@dirouter/translator': minor
'@dirouter/providers': minor
'@dirouter/routing': minor
'@dirouter/model-catalog': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

Documents and audio in translation: PDFs and other files (inline, by URL, as text or as a
provider file id) and audio input are now part of the canonical model and travel between OpenAI
Chat, Responses, Anthropic, Gemini, Vertex and Bedrock instead of being dropped. A destination
that cannot carry a part answers with a 400 that names it, and nothing is sent upstream. The
gateway routes such requests only to targets whose provider type and model can take them (new
model capabilities `documents` and `audioInput`, set in the catalog for OpenAI, Anthropic and
Gemini models; `false` excludes a model), and the `auto` aliases take them into account.
