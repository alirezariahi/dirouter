---
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/worker': minor
'@dirouter/dashboard': minor
---

Limits of a key on single models and input and output TPM apart. `POST/PATCH /orgs/:org/keys`
take `modelLimits`: per model, alias or combo name, RPM, TPM, input and output TPM, concurrency and
budgets. A model named there is limited wherever it serves the key (its used-up budget takes it out
of the route, so a combo falls back), an alias or combo name limits the requests for that name, and
every other model stays free. Keys and the limits API also take `inputTpm` and `outputTpm`; the
gateway reserves the input estimate and the output cap on separate windows in the same Lua script
and settles each with the real usage. The ledger records the requested name for reconcile, and the
key form edits limits per model.
