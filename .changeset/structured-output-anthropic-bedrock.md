---
'@dirouter/translator': minor
'@dirouter/providers': minor
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

Structured output on Anthropic and Bedrock: `response_format` with `json_schema` or `json_object`
is no longer dropped. Claude models with native structured outputs get `output_config.format`;
older Claude models and Bedrock get a forced `dirouter_structured_output` tool, whose call is
returned to the client as JSON text with `finish_reason: stop`, in streams too. Bedrock models that
reject a forced tool get `output_config.format` through `additionalModelRequestFields`. The
provider option `structuredOutput` (`native` or `tool`) overrides the choice. An Anthropic
client's `output_config.format` now also reaches OpenAI and Gemini. The mock provider answers
structured-output requests from the schema and serves the Bedrock Converse API.
