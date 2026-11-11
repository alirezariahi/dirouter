[English](feature-comparison.md) · [فارسی](feature-comparison.fa.md)

# DiRouter — competitor comparison, feature inventory, and architecture proposal

> Research date: 2026-11-07.
> Historical design snapshot, originally written before implementation began. Product claims, counts, licenses, and performance numbers below reflect that research and have not been re-verified as part of the English translation. The accepted [ADRs](../../adr/README.md) supersede its Go, ClickHouse, and queue proposals for the MVP.

---

## 1. Executive summary

- The three primary projects each have a different strength:
  - **Antirion:** a Rust enterprise gateway focused on performance, governance and access (SSO, SCIM, RBAC, audit), guardrails, and clustering with PostgreSQL and Valkey.
  - **OmniRoute:** a local gateway with the broadest reported provider coverage (350+), 19 routing strategies, context compression, memory, MCP, and A2A.
  - **9Router:** a lightweight developer tool with subscription/cheap/free fallback, token savings, and nine service types: chat, embeddings, TTS, STT, images, video, search, and fetch.
- **No single project combines every capability:** Antirion's enterprise controls, OmniRoute's provider/routing breadth, and **billing and credit sales**, primarily found in new-api.
- The DiRouter opportunity is one product in one monorepo with a **fast, resilient data plane**, a **complete control plane** (users, teams, budgets, billing), and a **strong operational dashboard**.
- **Original technical proposal:** NestJS + React + PostgreSQL is a good control-plane/dashboard fit. The research proposed **Go for the request hot path** (section 7), alongside **Valkey/Redis** and **ClickHouse**. Subsequent ADRs selected a TypeScript MVP, PostgreSQL aggregates, and BullMQ instead.

---

## 2. Projects reviewed

| #   | Project                                        | Type                              | Language             | License recorded in research                            | Deployment                                     | Main focus                                    |
| --- | ---------------------------------------------- | --------------------------------- | -------------------- | ------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| 1   | **Antirion**                                   | Enterprise gateway                | Rust, single binary  | Apache-2.0; all features free                           | Self-hosted only, single node or cluster, Helm | Performance, governance, guardrails           |
| 2   | **OmniRoute**                                  | Local/cloud gateway               | Node/TS, Electron    | MIT                                                     | npm, Docker, desktop, Termux, PWA, paid cloud  | Providers, routing, compression               |
| 3   | **9Router**                                    | Local gateway for coding tools    | Node/TS              | MIT                                                     | npm, Cloudflare tunnel                         | Subscription/free fallback, token savings     |
| 4   | **LiteLLM**                                    | Proxy and SDK                     | Python; Rust in beta | MIT; paid enterprise features                           | Docker, Helm, Terraform, PostgreSQL            | Established ecosystem, 100+ providers         |
| 5   | **Bifrost** (Maxim)                            | High-performance gateway          | Go                   | Apache-2.0; paid enterprise features                    | Docker, binary                                 | Performance, virtual keys, MCP                |
| 6   | **Portkey Gateway**                            | Gateway/platform                  | TS                   | MIT; paid platform; research records Palo Alto as owner | Node, Workers, Kubernetes, cloud               | Config-based routing, 50+ guardrails          |
| 7   | **new-api** (QuantumNous, an expanded one-api) | API resale gateway                | Go + React           | AGPL/MIT*                                               | Docker, SQLite/MySQL/PG, ClickHouse            | **Billing, top-ups, credit sales**            |
| 8   | **CLIProxyAPI**                                | OAuth-account proxy               | Go                   | MIT                                                     | Docker, cluster                                | Codex, Claude Code, Gemini CLI, Grok accounts |
| 9   | **Claude Code Router (CCR)**                   | Local agent control plane         | TS                   | MIT                                                     | npm, desktop, Docker                           | Agent profiles, conditional routing           |
| 10  | **TensorZero**                                 | Gateway, evaluation, optimization | Rust                 | Apache-2.0; research records archival in May/June 2026  | Docker                                         | A/B tests, evaluations, fine-tuning           |
| 11  | **Helicone AI Gateway**                        | Gateway and observability         | Rust                 | Apache/GPL discrepancy in research                      | npx, Docker, Kubernetes                        | PeakEWMA routing, caching                     |
| 12  | **LLM Gateway** (theopenco)                    | SaaS/self-hosted gateway          | TS (Hono, Next.js)   | AGPLv3 and enterprise edition                           | Unified Docker image                           | Monorepo and multitenancy patterns            |
| 13  | **OpenRouter**                                 | Closed SaaS marketplace           | Not specified        | Commercial                                              | Cloud only                                     | Credits, BYOK, provider routing               |
| 14  | **Kong / Envoy AI Gateway / agentgateway**     | API-gateway extensions            | Lua, Go, Rust        | OSS and enterprise                                      | Kubernetes                                     | Platform teams                                |

\* Recheck the applicable new-api license before reusing code.

> **Performance caveat from the original research:** figures such as Antirion's 0.5 ms and Bifrost's 11 microseconds are vendor-reported, use different methodologies, and are not directly comparable.

---

## 3. Combined feature inventory

Source key: **A** = Antirion, **O** = OmniRoute, **N** = 9Router, **L** = LiteLLM, **B** = Bifrost, **P** = Portkey, **NA** = new-api, **C** = CLIProxyAPI, **R** = CCR, **T** = TensorZero, **H** = Helicone, **G** = LLM Gateway, **OR** = OpenRouter. `(ent)` means enterprise edition.

Original priorities: **P0** = MVP, **P1** = version 1, **P2** = later. These research priorities do not replace the subsequent sprint plan.

### 3.1 API compatibility and format translation

| Feature                                                                                       | Sources        | Priority |
| --------------------------------------------------------------------------------------------- | -------------- | -------- |
| OpenAI Chat Completions-compatible endpoint                                                   | All            | P0       |
| OpenAI Responses API                                                                          | O, NA, C, R    | P0       |
| Anthropic Messages API, including Claude Code support                                         | A, O, NA, C, R | P0       |
| Gemini generateContent / Interactions                                                         | A, O, NA, C, R | P1       |
| Inbound Bedrock dialect                                                                       | A              | P2       |
| Bidirectional format translation, including streams, tool calls, and reasoning                | A, O, N, NA    | P0       |
| SSE streaming and non-streaming responses                                                     | All            | P0       |
| WebSocket / Realtime API                                                                      | NA, P, C       | P2       |
| `/v1/models` and model catalog                                                                | O, R           | P0       |
| Function calling, tools, structured output (JSON Schema)                                      | C, T, NA       | P0       |
| Multimodal inputs: images and files                                                           | C, T, P        | P1       |
| Drop-in support for official SDKs, LangChain, and Vercel AI SDK by changing only the base URL | A, B           | P0       |

### 3.2 Service types (modalities)

| Feature                                                                                 | Sources  | Priority |
| --------------------------------------------------------------------------------------- | -------- | -------- |
| Chat/LLM                                                                                | All      | P0       |
| Embeddings                                                                              | N, NA, T | P1       |
| Rerank                                                                                  | NA       | P2       |
| TTS / STT / translation                                                                 | N, NA, P | P2       |
| Image generation                                                                        | N, NA, P | P2       |
| Video generation and asynchronous tasks (Midjourney, Suno, Runway) with status tracking | N, NA    | P2       |
| Web search as a service (Tavily, Brave, Exa, Serper, etc.)                              | N, O     | P2       |
| Web fetch (Firecrawl, Jina Reader)                                                      | N        | P2       |
| Batch inference and Files API                                                           | T, L     | P2       |
| Fusion: add vision or web search to a model that lacks it                               | R        | P2       |

### 3.3 Providers and connection methods

| Feature                                                                                                                                                                                       | Sources        | Priority                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------- |
| Main API-key providers: OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, Mistral, Cohere, Groq, Together, Fireworks, DeepSeek, xAI, Cerebras, DeepInfra, Perplexity, OpenRouter, NVIDIA NIM | A, O, L        | P0                               |
| Any OpenAI-compatible server (vLLM, Ollama, LM Studio, llama.cpp, SGLang, TGI)                                                                                                                | All            | P0                               |
| Low-cost Chinese providers (GLM/Z.AI, Kimi, MiniMax, Qwen, SiliconFlow, Bailian)                                                                                                              | N, O, R        | P1                               |
| **OAuth subscriptions** (Claude Code, Codex, Gemini CLI, Copilot, Cursor, Kimi Code, Grok Build, Antigravity, Kiro)                                                                           | O, N, C, L     | P1, with caveats                 |
| Web-cookie authentication (ChatGPT Web, Claude Web, Gemini Web)                                                                                                                               | O, N           | Original recommendation: exclude |
| Free/keyless routes (Pollinations, OpenCode Free, Cloudflare AI)                                                                                                                              | O, N           | P2                               |
| Multiple accounts/keys per provider (credential pool)                                                                                                                                         | O, N, C, NA, R | P0                               |
| Custom provider definition through UI/plugins                                                                                                                                                 | C, R, NA       | P1                               |
| Protocol probing, automatic model discovery, connection testing                                                                                                                               | R, NA          | P1                               |
| Import local tool logins, such as `~/.codex`                                                                                                                                                  | R              | P2                               |
| Up-to-date model pricing catalog                                                                                                                                                              | P, O           | P0                               |
| Model mapping and aliases: virtual name to actual model                                                                                                                                       | NA, R          | P0                               |

> **Original research caution:** using personal OAuth/cookie subscriptions behind a multi-user gateway may conflict with service terms and lead to account restrictions. The research noted a similar 9Router warning about its MITM bridge. Its proposal was to keep any such support as an optional personal-use plugin with an explicit UI notice, and to exclude MITM bridges and web-cookie integration from the core. Reassess applicable terms before implementing any such integration.

### 3.4 Routing

| Feature                                                                                           | Sources        | Priority |
| ------------------------------------------------------------------------------------------------- | -------------- | -------- |
| Priority / fill-first, such as consuming subscription quota first                                 | O, N           | P0       |
| Weighted split                                                                                    | A, O, P, H, NA | P0       |
| Round-robin and sticky round-robin                                                                | O, N, C        | P0       |
| Least-used / least-busy                                                                           | O, L           | P1       |
| Power-of-two-choices (P2C) and latency-based PeakEWMA                                             | O, H           | P1       |
| Least-latency                                                                                     | A, H           | P1       |
| Least-cost / cost-optimized                                                                       | A, O, H, P     | P1       |
| Headroom-aware: prefer higher remaining quota                                                     | O              | P1       |
| Reset-aware / reset-window: account for quota reset time                                          | O              | P1       |
| Last-known-good                                                                                   | O              | P1       |
| Context-optimized / context-relay: select by context length                                       | O              | P1       |
| Cache-optimized: retain provider prompt cache through session affinity                            | O, NA          | P1       |
| Random / strict-random                                                                            | O              | P2       |
| Fusion / pipeline: combine multiple models                                                        | O              | P2       |
| **Classifier / tiered routing:** classify tasks and choose models                                 | A, C           | P1       |
| Automatic aliases: `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/smart`, `auto/offline` | O              | P1       |
| Adaptive multi-factor scoring; research recorded 15 factors in OmniRoute                          | O, B(ent)      | P2       |
| **Combo / virtual model:** a model chain with strategy and fallback                               | O, N, R        | P0       |
| Conditional routing by header, body, tag, or metadata                                             | P, R, L        | P1       |
| Separate team/project policies with per-rule traffic-share reporting                              | A              | P1       |
| Prefixes and request rewriting                                                                    | R              | P1       |
| Channel affinity: pin a user to a channel                                                         | NA             | P1       |
| A/B tests, canary, adaptive bandits                                                               | T, P           | P2       |

### 3.5 Resilience — special priority

| Feature                                                                         | Sources        | Priority |
| ------------------------------------------------------------------------------- | -------------- | -------- |
| Multi-level fallback: subscription to API to cheap to free                      | O, N, A        | P0       |
| Error-based fallback: 429, 5xx, timeout, content policy, context window         | P, L           | P0       |
| Retry with exponential backoff and jitter                                       | A, P, T        | P0       |
| **Request hedging:** send to a second provider when the first is slow           | A              | P1       |
| **Per-provider circuit breaker:** closed, open, half-open probes                | A, O           | P0       |
| Per-key/account cooldown while other credentials continue                       | O, L           | P0       |
| Model lockout: exclude only the rate-limited model, not the entire connection   | O              | P0       |
| Separate connect, first-token (TTFT), and total-request timeouts                | P, T           | P0       |
| Automatic channel disable/re-enable based on errors and periodic testing        | NA             | P0       |
| Active provider health checks                                                   | L, O           | P0       |
| Distribute traffic across keys to reduce rate-limit pressure                    | O, B           | P0       |
| Stateless multi-node operation with shared Valkey counters                      | A, NA          | P0       |
| Graceful shutdown and draining open streams                                     | Not attributed | P0       |
| Continue during DB/Redis outages: local config cache and configurable fail-open | Not attributed | P0       |
| Recover an interrupted stream, where feasible                                   | Not attributed | P2       |

### 3.6 Caching and token savings

| Feature                                                                                                                                              | Sources    | Priority |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Exact cache in Redis, S3, or memory with max-age, max-stale, invalidation                                                                            | A, H, L    | P1       |
| **Semantic cache** per model, team, or key using a vector store                                                                                      | A, O, B, P | P1       |
| Cache-status header such as `X-...-Cache: HIT` and savings reporting                                                                                 | O, A       | P1       |
| Provider prompt-cache accounting: cache reads/writes                                                                                                 | NA         | P0       |
| **Context compression:** session deduplication, tool-output filtering (git diff, grep, ls, tree), tabular compaction, relevance pruning, LLMLingua-2 | O, N       | P1       |
| Compression profiles (Lite, Standard, Aggressive, Ultra), configurable by request header                                                             | O          | P1       |
| Short-output mode (Caveman / terse), with levels                                                                                                     | N, O       | P2       |
| Anthropic Context Editing and context-budget dial                                                                                                    | O          | P2       |
| Compression Studio UI and offline evaluations                                                                                                        | O          | P2       |

### 3.7 Keys, access, and identity

| Feature                                                                     | Sources           | Priority |
| --------------------------------------------------------------------------- | ----------------- | -------- |
| Virtual/gateway keys with allowed models, expiration, IP allowlists, limits | A, L, B, P, NA, R | P0       |
| Encrypted provider credentials (AES-256-GCM, envelope encryption)           | A, O              | P0       |
| Vault/KMS integration (HashiCorp, AWS KMS)                                  | B(ent)            | P2       |
| **Org → Team → Project → Key → User** hierarchy                             | A, L, B           | P0       |
| Custom roles and RBAC                                                       | A, P, NA          | P1       |
| SSO: OIDC, SAML, GitHub, Google                                             | A, L, B           | P1       |
| SCIM provisioning and directory synchronization                             | A, B              | P2       |
| MFA: TOTP, WebAuthn, passkeys                                               | A, NA             | P1       |
| Login-session management                                                    | NA                | P1       |
| Change requests for sensitive operations, such as four-eyes approval        | A                 | P2       |
| Complete audit log                                                          | A, L, P           | P1       |
| Model access groups                                                         | L                 | P1       |
| End-user OAuth login (GitHub, Google, Telegram, Discord, OIDC)              | NA                | P1       |
| IP/geography access restrictions                                            | P(ent)            | P2       |
| End-user IDs for tracking                                                   | L, B              | P1       |

### 3.8 Budgets, quotas, and rate limits

| Feature                                                                 | Sources    | Priority |
| ----------------------------------------------------------------------- | ---------- | -------- |
| RPM, TPM, concurrent-request, and image-count limits                    | A, L, H, R | P0       |
| Dollar/token budgets at org, team, project, key, user, and model levels | A, L, B, H | P0       |
| Daily/weekly/monthly budgets with automatic reset                       | L          | P0       |
| Cost forecasting and predicted budget exhaustion date                   | A          | P1       |
| A **ledger** behind every cost figure                                   | A          | P0       |
| Subscription quota tracking and reset countdown                         | N, O       | P1       |
| Fair share between teammates using one subscription                     | O          | P2       |
| Free-quota pool accounting without double counting                      | O          | P2       |
| Budget-threshold alerts at 50%, 80%, and 100%                           | L          | P1       |

### 3.9 Billing and monetization

The research did not identify this full capability set in Antirion or OmniRoute. Its main source was new-api, described as an API sales panel. Items marked with a dagger (†) came from documentation or earlier versions and need rechecking before implementation.

| Feature                                                                            | Sources                        | Priority |
| ---------------------------------------------------------------------------------- | ------------------------------ | -------- |
| User wallet/prepaid credit                                                         | NA, OR                         | P1       |
| Online top-ups through Stripe and †Epay; Iranian options: Zarinpal, IDPay, NextPay | NA†                            | P1       |
| Gift/top-up redemption codes                                                       | NA†                            | P1       |
| Referral/affiliate rewards                                                         | NA†                            | P2       |
| Subscription plans                                                                 | NA, G(ent)                     | P2       |
| Model, output, user-group, and cache pricing multipliers                           | NA                             | P1       |
| Per-request pricing for images/video                                               | NA                             | P1       |
| Expression-based tiered usage pricing                                              | NA                             | P2       |
| Public model marketplace with prices                                               | NA, OR                         | P1       |
| Bring your own key (BYOK)                                                          | OR                             | P1       |
| Invoices, monthly statements, CSV/PDF export                                       | No complete example identified | P2       |
| Profit reporting: upstream purchase cost versus sales revenue                      | Differentiation opportunity    | P2       |

### 3.10 Guardrails and content security

| Feature                                                         | Sources    | Priority |
| --------------------------------------------------------------- | ---------- | -------- |
| PII/secret detection, including API keys and tokens             | A, O, L, P | P1       |
| Regex and word lists                                            | A, P       | P1       |
| Output JSON Schema validation                                   | A, P       | P1       |
| Prompt-injection detection                                      | O          | P1       |
| Provider-agnostic moderation                                    | A, O       | P1       |
| LLM-as-judge                                                    | A, T       | P2       |
| Tool-permission checks                                          | A          | P2       |
| Apply checks to requests, responses, and **streams**            | A          | P1       |
| Actions: block, format-preserving redact, flag, divert          | A          | P1       |
| Third-party guardrail plugins; research recorded 40+ in Portkey | P          | P2       |
| Content logging off by default; when enabled, mask/hash PII     | A          | P0       |

### 3.11 Agents, MCP, and A2A

| Feature                                                                                               | Sources    | Priority |
| ----------------------------------------------------------------------------------------------------- | ---------- | -------- |
| **MCP Gateway:** register MCP servers and apply keys, budgets, logs                                   | A, L, B, P | P1       |
| Gateway's own administrative MCP server over stdio, HTTP, SSE; research recorded 110 OmniRoute tools  | O          | P2       |
| Forward user identity to MCP servers                                                                  | P          | P2       |
| MCP Code Mode                                                                                         | B          | P2       |
| **A2A:** Agent Card at `/.well-known` and JSON-RPC (`message/send`, `tasks/get`)                      | A, O, L    | P2       |
| Agent profiles (Claude Code, Codex, OpenCode, etc.) with model overrides and one-click configuration  | R, N, O    | P1       |
| Setup guides for Claude Code, Codex, Cursor, Cline, Roo, Kilo, Continue, Aider, Goose, Windsurf, etc. | O, N       | P0       |
| VS Code extension to add models to the picker                                                         | O          | P2       |
| Conversation memory (FTS/vector), with retention controls                                             | O          | P2       |
| Agent relay through Telegram, Slack, Discord                                                          | R          | P2       |

### 3.12 Observability and analytics

| Feature                                                                                                                               | Sources    | Priority |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Per-request logs: chosen route, **every attempt and its failure reason**, tokens, cost, cache status, guardrail result, latency, TTFT | A, R, L    | P0       |
| Agent/tool-call tracing                                                                                                               | R          | P1       |
| Prometheus metrics                                                                                                                    | A, B, T, L | P0       |
| OpenTelemetry traces, metrics, logs                                                                                                   | A, H, T, L | P1       |
| External log sinks: Langfuse, Datadog, S3, Kafka                                                                                      | A, L       | P2       |
| Separate log database (ClickHouse)                                                                                                    | NA         | P1       |
| Replay previous requests with a different model/prompt                                                                                | T          | P2       |
| Build datasets from real traffic, with evaluation and feedback                                                                        | T          | P2       |
| Alerts through Slack, Telegram, email, webhooks                                                                                       | L, NA†     | P1       |

### 3.13 Configuration and operations

| Feature                                                              | Sources  | Priority                                       |
| -------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| Declarative YAML configuration edited through files, API, or console | A, H     | P1                                             |
| Schema validation, **diffs, versioning, and rollback**               | A        | P1                                             |
| Hot reload without restart                                           | C, A     | P0                                             |
| GitOps                                                               | T        | P2                                             |
| Initial setup wizard                                                 | NA       | P0                                             |
| Global/provider/connection outbound SOCKS5/HTTP proxy                | O, N     | P0; especially relevant to Iranian deployments |
| Proxy pool, IP rotation, relay                                       | N, O     | P1                                             |
| Remote access tunnel (Cloudflare Tunnel)                             | N        | P2                                             |
| IPv4/IPv6 egress controls                                            | O        | P2                                             |
| Internationalization, including **Persian and RTL**                  | NA       | P0                                             |
| Model playground                                                     | NA, T, G | P1                                             |
| Middleware/plugin system                                             | B, NA, R | P2                                             |
| Complete management API covering all UI operations                   | C, A     | P0                                             |
| Embeddable SDK                                                       | C        | P2                                             |

### 3.14 Deployment and supply chain

| Feature                                                     | Sources  | Priority |
| ----------------------------------------------------------- | -------- | -------- |
| Distroless/non-root Docker images for amd64 and arm64       | A, O, NA | P0       |
| Docker Compose for single-node and clustered deployments    | A, C     | P0       |
| Helm chart with HPA autoscaling                             | A, L     | P1       |
| Lightweight personal single-node mode with embedded storage | A, O     | P2       |
| npm, Electron/Tauri desktop application, PWA                | O, N, R  | P2       |
| SBOM, Sigstore signatures, SLSA provenance                  | A        | P2       |
| Published benchmark harness                                 | A, H     | P1       |

---

## 4. Feature comparison matrix

Legend: ✅ supported, ⚠️ partial or paid edition only, ❌ absent or not reported. These are the original research assessments, not current verified product specifications.

| Capability                          | Antirion | OmniRoute     | 9Router | LiteLLM | Bifrost | Portkey | new-api | CLIProxy | CCR | **DiRouter target** |
| ----------------------------------- | -------- | ------------- | ------- | ------- | ------- | ------- | ------- | -------- | --- | ------------------- |
| OpenAI / Anthropic / Gemini API     | ✅       | ✅            | ✅      | ✅      | ✅      | ✅      | ✅      | ✅       | ✅  | ✅                  |
| Format translation                  | ✅       | ✅            | ✅      | ✅      | ✅      | ✅      | ✅      | ✅       | ✅  | ✅                  |
| Provider count                      | ~17      | 350+          | 60+     | 100+    | 23+     | 45+     | ~30+    | ~10      | ~10 | 50+                 |
| OAuth subscriptions                 | ❌       | ✅            | ✅      | ⚠️      | ❌      | ❌      | ❌      | ✅       | ⚠️  | ⚠️ plugin           |
| Images, audio, video                | ❌       | ⚠️            | ✅      | ✅      | ⚠️      | ✅      | ✅      | ❌       | ❌  | ✅                  |
| Combo / virtual model               | ⚠️       | ✅            | ✅      | ⚠️      | ❌      | ✅      | ⚠️      | ❌       | ✅  | ✅                  |
| Routing-strategy count              | ~7       | 19            | 2       | ~5      | ~2      | ~3      | ~2      | 1        | ~2  | 15+                 |
| Classifier routing                  | ✅       | ✅ auto       | ❌      | ❌      | ❌      | ⚠️      | ❌      | ⚠️       | ⚠️  | ✅                  |
| Circuit breaker                     | ✅       | ✅            | ❌      | ⚠️      | ✅      | ❌      | ⚠️      | ❌       | ❌  | ✅                  |
| Request hedging                     | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅                  |
| Credential cooldown / model lockout | ⚠️       | ✅            | ⚠️      | ✅      | ⚠️      | ❌      | ✅      | ⚠️       | ⚠️  | ✅                  |
| Exact cache                         | ✅       | ⚠️            | ❌      | ✅      | ⚠️      | ✅      | ❌      | ❌       | ❌  | ✅                  |
| Semantic cache                      | ✅       | ✅            | ❌      | ✅      | ✅      | ⚠️      | ❌      | ❌       | ❌  | ✅                  |
| Context compression                 | ❌       | ✅ 12 engines | ✅ RTK  | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅                  |
| Virtual keys / hierarchical budgets | ✅       | ⚠️            | ❌      | ✅      | ✅      | ✅      | ✅      | ❌       | ⚠️  | ✅                  |
| Rate limits (RPM/TPM/cost)          | ✅       | ✅            | ❌      | ✅      | ✅      | ⚠️      | ⚠️      | ❌       | ✅  | ✅                  |
| SSO / SCIM                          | ✅       | ❌            | ❌      | ⚠️      | ⚠️      | ⚠️      | ⚠️ OIDC | ❌       | ❌  | ✅                  |
| MFA / passkeys                      | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ✅      | ❌       | ❌  | ✅                  |
| RBAC / audit                        | ✅       | ❌            | ❌      | ⚠️      | ⚠️      | ✅      | ⚠️      | ❌       | ❌  | ✅                  |
| **Billing / top-ups**               | ❌       | ⚠️ cloud      | ❌      | ❌      | ❌      | ❌      | ✅      | ❌       | ❌  | ✅                  |
| Guardrails                          | ✅       | ✅            | ❌      | ✅      | ⚠️      | ✅      | ❌      | ❌       | ❌  | ✅                  |
| MCP Gateway                         | ✅       | ✅            | ❌      | ✅      | ✅      | ✅      | ❌      | ❌       | ✅  | ✅                  |
| A2A                                 | ✅       | ✅            | ❌      | ✅      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅ P2               |
| Prometheus / OpenTelemetry          | ✅       | ❌            | ❌      | ✅      | ✅      | ⚠️      | ❌      | ❌       | ❌  | ✅                  |
| Analytics dashboard                 | ✅       | ✅            | ⚠️      | ✅      | ✅      | ⚠️      | ✅      | ❌       | ✅  | ✅++                |
| Config diffs / rollback             | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅                  |
| Outbound proxy / pool               | ❌       | ✅            | ✅      | ⚠️      | ❌      | ❌      | ✅      | ⚠️       | ❌  | ✅                  |
| Clustering / HA                     | ✅       | ⚠️            | ❌      | ✅      | ⚠️      | ✅      | ✅      | ✅       | ❌  | ✅                  |
| Helm / Kubernetes                   | ✅       | ❌            | ❌      | ✅      | ⚠️      | ✅      | ⚠️      | ❌       | ❌  | ✅                  |
| Persian / RTL                       | ❌       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅                  |

---

## 5. Proposed DiRouter resilience design

Primary principle: **the data plane must not depend on the control plane**. PostgreSQL, NestJS, or dashboard outages must not interrupt existing traffic.

1. **Separate data and control planes.** Gateway receives configuration from the control plane, stores a versioned snapshot in memory and on disk, and receives updates through Valkey pub/sub or long polling. It continues with the last valid configuration during control-plane outages.
2. **Stateless gateways with distributed counters.** Implement rate limits and budgets in Valkey, using sliding windows or GCRA with Lua scripts. **Local fallback:** divide quotas between nodes and use in-memory limiting when Valkey is unavailable. Make fail-open/fail-closed configurable per tenant.
3. **Asynchronous accounting.** Record live consumption in Valkey, enqueue events (the research proposed NATS JetStream or Redis Streams), then persist a PostgreSQL ledger and ClickHouse logs. The request path never waits for database writes. An **idempotency key** prevents duplicate charges; a local on-disk outbox covers queue outages. The accepted MVP later selected BullMQ and PostgreSQL logs instead.
4. **Three fault-isolation layers, following the OmniRoute pattern:** provider circuit breakers, per-credential cooldowns, and per-model lockouts, with half-open probes and adaptive backoff.
5. **Hedging and timeouts:** separate connect, TTFT, and stream-idle timeouts. If TTFT exceeds p95, consider sending a hedge to a second provider, only for idempotent requests or with an explicit hedge budget.
6. **Stream-safe failover:** allow full fallback before sending client bytes. After partial output, return a standard error. Cross-provider stream continuation is experimental P2 work.
7. **Bulkheads:** separate connection pools and concurrency limits per provider and tenant so one slow provider or heavy customer cannot exhaust the system.
8. **Infrastructure proposal:** PostgreSQL with Patroni or CloudNativePG (primary/replica) and PgBouncer; Valkey Sentinel or Cluster; initially single-node ClickHouse; gateway replicas behind a load balancer, with PodDisruptionBudgets, readiness/liveness probes, and graceful SSE draining.
9. **Chaos and load tests:** k6 or vegeta with a mock provider generating 429, 5xx, and random latency in CI. Proposed SLOs: p99 overhead below 5 ms and availability of 99.95%.

---

## 6. Practical dashboard — proposed pages

Combine Antirion's Overview and per-attempt logs, OmniRoute's Health/Costs tabs, new-api's model marketplace and playground, and CCR's request diagnostics.

| Page                            | Contents                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                    | Cost, requests, tokens, p50/p95/p99 latency, TTFT, error/cache-hit rates, savings from cache/compression/free routes, top models/teams, **provider headroom**              |
| **Live / Realtime**             | WebSocket request stream, current RPS, in-flight requests, provider-status map                                                                                             |
| **Health**                      | Provider breaker states, cooling keys, locked models and unlock times, incident history, provider uptime                                                                   |
| **Requests (Log Explorer)**     | Filters by key/team/model/status/cost/latency; request details with attempt timelines, failure reasons, guardrails, cache status, optional body logging, playground replay |
| **Costs & Budgets**             | Cost by org/team/project/key/user/model, forecasts and exhaustion dates, ledger, subscription/free/paid split, CSV export                                                  |
| **Quotas**                      | Account/subscription quotas, reset countdown, utilization                                                                                                                  |
| **Providers & Credentials**     | Add-provider wizard, connection tests, model discovery, multiple credentials, per-connection proxy settings                                                                |
| **Models / Catalog**            | Prices, context windows, capabilities, aliases/mappings, public model marketplace                                                                                          |
| **Routing / Combos**            | Drag-and-drop fallback/strategy editor, **routing simulator**, per-rule traffic share                                                                                      |
| **Keys & Access**               | Virtual keys, allowed models, limits, expiration, IP allowlists, rotation                                                                                                  |
| **Org / Teams / Users / Roles** | Hierarchy, RBAC, SSO/SCIM, invitations                                                                                                                                     |
| **Billing**                     | Wallet, top-ups, gift codes, plans, invoices, group prices, profit reporting                                                                                               |
| **Guardrails**                  | Policies, live tests, block/redaction statistics                                                                                                                           |
| **Cache & Compression**         | Hit rates, savings, cache purge, Compression Studio                                                                                                                        |
| **MCP & Agents**                | MCP-server registration, tool access/logs, agent profiles with ready-to-use Claude Code/Codex snippets                                                                     |
| **Playground**                  | Side-by-side model comparisons with cost and latency                                                                                                                       |
| **Config**                      | Validated YAML editing, diffs, history, rollback, change requests                                                                                                          |
| **Alerts**                      | Budget/error/outage rules and Telegram/Slack/email/webhook channels                                                                                                        |
| **Audit Log**                   | Every configuration change with a diff                                                                                                                                     |

UX proposals:

- Full RTL/LTR, Solar Hijri/Gregorian calendars, light/dark themes.
- Global time range, chart-to-log drill-down, shareable filter links.
- Command palette (`Cmd+K`).

---

## 7. Original technology proposal

### 7.1 Evaluating NestJS + React + PostgreSQL

| Layer                                                          | Original user choice | Research assessment                                                                                                                                                                                                               | Original proposal                                                                                                                           |
| -------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane:** admin API, auth, billing, config, reporting | NestJS               | Strong fit: modules, DI, guards/RBAC, OpenAPI, ecosystem                                                                                                                                                                          | **NestJS with Fastify adapter**                                                                                                             |
| **Data plane:** LLM request hot path                           | NestJS               | The research considered per-request DI/interceptors/pipes and Node GC/single-thread execution a tail-latency and memory risk at tens of thousands of concurrent streams. It contrasted Rust/Go gateways with local Node projects. | **Go**, with Rust as an alternative; later superseded by ADR-001                                                                            |
| **Frontend**                                                   | React                | Suitable                                                                                                                                                                                                                          | React + Vite + TypeScript, TanStack Router/Query, shadcn/ui (Radix) + Tailwind with RTL, ECharts or Recharts, TanStack Table, react-i18next |
| **Primary database**                                           | PostgreSQL           | Strong fit for users, keys, config, ledger                                                                                                                                                                                        | **PostgreSQL 17** + PgBouncer                                                                                                               |
| **Logs and analytics**                                         | PostgreSQL           | Research anticipated difficulties with millions of daily raw log rows and fast aggregates                                                                                                                                         | **ClickHouse**, as used by new-api; TimescaleDB was another initial option for low volume                                                   |
| **Counters, cache, pub/sub**                                   | Unspecified          | Needed                                                                                                                                                                                                                            | **Valkey**, an open Redis fork                                                                                                              |
| **Event queue**                                                | Unspecified          | Needed                                                                                                                                                                                                                            | **NATS JetStream**, or Redis Streams initially                                                                                              |
| **Vectors for semantic cache/memory**                          | Unspecified          | Needed                                                                                                                                                                                                                            | **pgvector** on PostgreSQL; Qdrant at higher scale                                                                                          |

### 7.2 Why Go for the data plane?

The original research rationale was:

- Sub-millisecond overhead and stable tail latency, citing Bifrost as a Go example.
- Goroutines suit many concurrent SSE streams; `net/http` and `httputil` are mature.
- CLIProxyAPI and new-api provide examples of translators and executors in Go.
- Go would be easier for a TypeScript team to learn than Rust. Rust was suggested primarily for a direct performance challenge to Antirion.
- **For a TypeScript-only team,** an alternative was plain Node + Fastify or uWebSockets, without Nest, as a separate service with a stable interface that could later be replaced by Go. The research still preferred Go for its high-scale target.

These were design proposals, not measured DiRouter results. ADR-001 subsequently selected NestJS on Fastify with strict hot-path rules and a benchmark-based rewrite option.

### 7.3 Originally proposed monorepo

```text
dirouter/
├─ apps/
│  ├─ gateway/          # Go data plane: routing, fallback, limits, translation
│  ├─ control-api/      # NestJS: administration, auth, billing, config
│  ├─ worker/           # NestJS: ledger, aggregates, alerts, health probes
│  ├─ dashboard/        # React + Vite management console
│  ├─ portal/           # Optional React end-user wallet/model marketplace
│  └─ docs/             # Astro Starlight or Docusaurus documentation site
├─ packages/
│  ├─ contracts/        # JSON Schema / OpenAPI / Protobuf shared by Go and TS
│  ├─ model-catalog/    # Versioned JSON prices and capabilities
│  ├─ ui/               # Shared React components
│  ├─ sdk-ts/           # Management SDK
│  └─ config/           # ESLint, tsconfig, and related configuration
├─ deploy/             # Docker Compose, Helm, Kubernetes
└─ tools/              # Mock provider, load tests, chaos
```

- Monorepo tooling: **pnpm workspaces + Turborepo**, or **Nx** with a Go plugin.
- NestJS ORM: **Drizzle** or **Prisma**. Existing team Prisma experience supported retaining it. Run migrations from a single source of truth.
- Go/TS contracts: JSON configuration snapshots with a shared schema. Internal communication could use gRPC/HTTP plus Valkey pub/sub.

The actual TypeScript-first repository layout is documented in the [project README](../../../README.md).

---

## 8. Original proposed roadmap

| Phase        | Scope                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP (P0)** | OpenAI/Anthropic APIs and translation, about 15 primary providers plus OpenAI-compatible servers, combos/multi-level fallback, breakers/cooldowns/lockouts/retry/timeouts, virtual keys, org/team/project, rate limits/budgets, ledger, request logs, outbound proxy, Overview/Health/Requests/Providers/Keys/Combos pages, Persian/RTL, Docker Compose |
| **v1 (P1)**  | Full Gemini/Responses APIs, latency/cost/headroom/classifier routing, hedging, exact/semantic cache, RTK/dedup compression, SSO/MFA/RBAC/audit, guardrails, MCP gateway, wallet/payments/gift codes/pricing multipliers, ClickHouse, OTel/Prometheus, Helm, config diffs/rollback, playground, alerts                                                   |
| **v2 (P2)**  | Full images/audio/video/search, A2A, memory, SCIM, plugins, A/B/evaluations, VS Code extension, desktop, optional OAuth-subscription plugins with terms notices, SBOM/signing                                                                                                                                                                           |

---

## 9. Decisions requested in the original research

1. **Business model:** enterprise self-hosting only, like Antirion, or an API sales panel as well, like new-api/OpenRouter? This sets the weight of billing work.
2. **OAuth subscriptions and web cookies:** exclude them, provide optional plugins, or include them in core, taking service terms into account?
3. **Data-plane language:** Go, Rust, or plain Node? The research preferred Go; ADR-001 records the later accepted choice.
4. **Payment gateways:** Iranian, international, or both?

---

## Sources recorded by the research

- [Antirion](https://antirion.ai/)
- [OmniRoute website](https://www.omniroute.online/) and [repository](https://github.com/cheaper-inference/OmniRoute)
- [9Router website](https://9router.com/) and [repository](https://github.com/decolua/9router)
- [LiteLLM proxy documentation](https://docs.litellm.ai/docs/simple_proxy)
- [Bifrost repository](https://github.com/maximhq/bifrost)
- [Portkey Gateway repository](https://github.com/Portkey-AI/gateway)
- [new-api repository](https://github.com/QuantumNous/new-api) and [documentation](https://docs.newapi.ai/)
- [CLIProxyAPI repository](https://github.com/router-for-me/CLIProxyAPI)
- [Claude Code Router repository](https://github.com/musistudio/claude-code-router)
- [TensorZero repository](https://github.com/tensorzero/tensorzero)
- [Helicone AI Gateway repository](https://github.com/Helicone/ai-gateway)
- [LLM Gateway repository](https://github.com/theopenco/llmgateway)
- [Maxim: Portkey alternatives](https://www.getmaxim.ai/articles/top-5-portkey-alternatives-in-2026/)
- [LLM Gateway: LiteLLM alternatives](https://llmgateway.io/blog/litellm-alternatives)
- [Coworker: LiteLLM alternatives](https://coworker.ai/blog/litellm-alternatives)
