---
'@dirouter/providers': minor
'@dirouter/routing': minor
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

Vertex AI accepts a service-account JSON key as the credential and Azure OpenAI accepts Entra ID client credentials (`options.authMode: "entra"`). The gateway signs the JWT or runs the client-credentials grant, caches the access token per credential and refreshes it before expiry; token URLs can be overridden per provider. A failed token exchange cools down only that credential, never the whole provider. The mock provider serves both token endpoints and a Vertex route (card 27.4).
