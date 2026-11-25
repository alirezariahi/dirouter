---
'@dirouter/contracts': minor
'@dirouter/model-catalog': minor
'@dirouter/db': minor
'@dirouter/worker': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/mock-provider': minor
---

The model catalog and prices sync from external sources (LiteLLM's public price list by default, or an internal mirror) in a periodic worker job with validation, a diff and a truncation guard. New models appear in the catalog without a release; price changes become proposals that an operator approves in the dashboard (or apply automatically, configurable), and request costs keep the current price until then. Pricing gains context-length tiers, a batch discount and a deprecation date; organization models priced by hand are never repriced. Without internet the last good catalog stays in force (card 27.5).
