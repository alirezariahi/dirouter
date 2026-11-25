---
'@dirouter/gateway': minor
'@dirouter/providers': minor
'@dirouter/mock-provider': minor
---

`/v1/moderations` works with the official OpenAI SDK unchanged (card 30.3): multimodal input (text and `image_url` parts, judged together) is passed to the provider as is, and `category_applied_input_types` is returned when the provider reports it. The mock provider answers multimodal moderation input.
