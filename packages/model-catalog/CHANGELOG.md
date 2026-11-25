# @dirouter/model-catalog

## 1.1.0

### Minor Changes

- 1c129b4: The model catalog and prices sync from external sources (LiteLLM's public price list by default, or an internal mirror) in a periodic worker job with validation, a diff and a truncation guard. New models appear in the catalog without a release; price changes become proposals that an operator approves in the dashboard (or apply automatically, configurable), and request costs keep the current price until then. Pricing gains context-length tiers, a batch discount and a deprecation date; organization models priced by hand are never repriced. Without internet the last good catalog stays in force (card 27.5).
- daaa0ee: Documents and audio in translation: PDFs and other files (inline, by URL, as text or as a
  provider file id) and audio input are now part of the canonical model and travel between OpenAI
  Chat, Responses, Anthropic, Gemini, Vertex and Bedrock instead of being dropped. A destination
  that cannot carry a part answers with a 400 that names it, and nothing is sent upstream. The
  gateway routes such requests only to targets whose provider type and model can take them (new
  model capabilities `documents` and `audioInput`, set in the catalog for OpenAI, Anthropic and
  Gemini models; `false` excludes a model), and the `auto` aliases take them into account.

### Patch Changes

- Updated dependencies [5e49aec]
- Updated dependencies [1c129b4]
- Updated dependencies [daaa0ee]
- Updated dependencies [5838d61]
- Updated dependencies [51e84e1]
- Updated dependencies [db53f8a]
- Updated dependencies [8cc1c17]
- Updated dependencies [3a57a03]
- Updated dependencies [76398b4]
- Updated dependencies [5e39c70]
- Updated dependencies [cfbfa14]
- Updated dependencies [c253e17]
- Updated dependencies [219ddc9]
  - @dirouter/contracts@1.1.0
  - @dirouter/shared@1.1.0

## 1.0.0

### Major Changes

- DiRouter 1.0: the first stable release.

  - **Gateway:** OpenAI, Anthropic, Responses and Gemini APIs on one endpoint, with routing,
    fallback, hedging, circuit breakers, rate limits, budgets, caching, guardrails, auto routing,
    embeddings, images, speech and transcription, MCP and A2A.
  - **Billing:** prepaid wallets on a double-entry ledger, online top-ups, gift codes, sale prices
    and plans, invoices, and a self-service portal.
  - **Enterprise:** OIDC and SAML sign-in, SCIM provisioning, custom roles, audit log, four-eyes
    approval for sensitive changes, provider plugins.
  - **Operations:** signed images with SBOMs, a threat model, a Helm chart, HA compose, a
    documentation site and a reproducible benchmark.

  Upgrading from 0.x (the MVP) needs no manual data changes: see docs/upgrade-v1.md.

### Patch Changes

- Updated dependencies
  - @dirouter/contracts@1.0.0
  - @dirouter/shared@1.0.0
