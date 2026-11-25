# Azure OpenAI

- `type: azure-openai`, `baseUrl: https://<resource>.openai.azure.com`
- The `upstreamModel` of each model = **deployment name**
- `options.apiVersion` (default `2024-10-21`)
- Authentication uses the `api-key` header by default; the `model` field is not sent in the body
- Output token cap field: `max_completion_tokens`

## Entra ID client credentials (card 27.4)

Set `options.authMode: "entra"` and store the app registration as the credential secret, as JSON:

```json
{ "tenantId": "<tenant id or domain>", "clientId": "<application id>", "clientSecret": "<secret>" }
```

The secret is encrypted with `MASTER_KEY` like every other credential. The gateway uses the Entra ID v2 client-credentials grant (`POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `https://cognitiveservices.azure.com/.default`), caches the access token per credential, refreshes it before it expires and sends it as `Authorization: Bearer …` instead of `api-key`. The app registration needs the _Cognitive Services OpenAI User_ role on the resource.

| Option                  | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `options.authorityHost` | Authority for sovereign clouds (default `https://login.microsoftonline.com`)   |
| `options.tokenUrl`      | Full token URL, overriding the authority (a private endpoint or a test server) |
| `options.scope`         | Scope (default `https://cognitiveservices.azure.com/.default`)                 |

A failed token exchange puts **only that credential** in cooldown (exponential backoff), never the whole provider: other credentials keep serving and the circuit breaker is not touched. While a cached token is still valid a failed refresh does not interrupt traffic. Vertex service accounts use the same mechanism; see [vertex](vertex.md).
