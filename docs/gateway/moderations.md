# Moderations endpoint (card 30.3)

`POST /v1/moderations` is OpenAI's moderation API, so the official OpenAI SDKs work unchanged (`client.moderations.create(...)`). It runs on the same code as the `moderation` guardrail (card 23.2): the model is routed with the caller's key to the configured provider, with fallback, rate limits, budgets, the wallet and a usage event (`inboundApi: "openai.moderations"`).

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key=DIROUTER_KEY)
result = client.moderations.create(input="I want to hurt someone")
print(result.results[0].flagged, result.results[0].categories)
```

## Request

| Field   | Value                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model` | A DiRouter model name, alias or combo. Without it, `omni-moderation-latest`, OpenAI's default, which must exist as a model (or alias) in the organization.                                                       |
| `input` | A string; an array of strings (one result each); or an array of `{"type": "text", "text": …}` and `{"type": "image_url", "image_url": {"url": …}}` parts, judged together as one input (omni moderation models). |

The model's provider must serve an OpenAI-compatible `/moderations` (OpenAI and OpenAI-compatible types; Azure OpenAI has none). Image parts are passed to the provider as they are; a provider that cannot read them answers with an error and the next target is tried.

## Response

```json
{
  "id": "modr-…",
  "model": "omni-moderation-latest",
  "results": [
    {
      "flagged": true,
      "categories": { "violence": true, "hate": false },
      "category_scores": { "violence": 0.91, "hate": 0.01 },
      "category_applied_input_types": { "violence": ["text"], "hate": ["text"] }
    }
  ]
}
```

`category_applied_input_types` is returned when the provider reports it. The headers `x-dirouter-model` and `x-dirouter-provider` show where the request went.

## Price

Moderation endpoints report no usage: the input is estimated (a quarter of its characters in tokens, 85 tokens per image) and priced at the model's input price, which is usually 0 for OpenAI's free moderation models.
