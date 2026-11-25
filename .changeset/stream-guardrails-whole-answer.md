---
'@dirouter/gateway': patch
'@dirouter/contracts': patch
---

A blocking whole-answer guardrail (json_schema, moderation, injection classifier) now holds every stream event until the answer is complete, so text after a tool call or in a later block is judged too; an answer too long to judge is blocked, and a moderation or classifier policy with no verdict in traffic follows its fail mode.
