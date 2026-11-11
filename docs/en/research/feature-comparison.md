[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

---

<a id="persian"></a>

# DiRouter — مقایسه‌ی رقبا، فهرست کامل فیچرها و پیشنهاد معماری

> تاریخ بررسی: 2026-11-07.
> نسخه‌ی تاریخی طراحی که پیش از شروع پیاده‌سازی نوشته شده است. ادعاهای محصول، تعداد، لایسنس‌ها و اعداد کارایی زیر مربوط به همان بررسی‌اند و در ترجمه‌ی انگلیسی دوباره تأیید نشده‌اند. [ADRهای پذیرفته‌شده](../../adr/README.md) پیشنهادهای Go، ClickHouse و صف را برای MVP جایگزین کرده‌اند.

---

## ۱. خلاصه‌ی مدیریتی

- سه پروژه‌ی اصلی هرکدام در یک حوزه قوی‌اند:
  - **Antirion:** یک گیت‌وی سازمانی با Rust که روی کارایی، حاکمیت و دسترسی (SSO، SCIM، RBAC، audit)، guardrail و کلاسترینگ با PostgreSQL و Valkey تمرکز دارد.
  - **OmniRoute:** یک گیت‌وی محلی با بیشترین تعداد provider گزارش‌شده (بیش از ۳۵۰)، ۱۹ استراتژی مسیریابی، فشرده‌سازی context، حافظه، MCP و A2A.
  - **9Router:** یک ابزار سبک برای توسعه‌دهندگان، با fallback اشتراک/ارزان/رایگان، صرفه‌جویی توکن و نه نوع سرویس: chat، embeddings، TTS، STT، تصویر، ویدیو، جستجو و fetch.
- **هیچ پروژه‌ای همه‌ی قابلیت‌ها را با هم ندارد:** کنترل‌های سازمانی Antirion، گستره‌ی provider و مسیریابی OmniRoute، و **صورت‌حساب و فروش اعتبار** که بیشتر در new-api دیده می‌شود.
- فرصت DiRouter یک محصول در یک مونوریپو است، با **data plane سریع و تاب‌آور**، **control plane کامل** (کاربران، تیم‌ها، بودجه‌ها، صورت‌حساب) و **داشبورد عملیاتی قوی**.
- **پیشنهاد فنی اولیه:** NestJS + React + PostgreSQL برای control plane و داشبورد مناسب است. پژوهش **Go را برای مسیر داغ درخواست‌ها (data plane)** پیشنهاد می‌کرد (بخش ۷)، در کنار **Valkey/Redis** و **ClickHouse**. ADRهای بعدی به‌جای آن یک MVP با TypeScript، aggregateهای PostgreSQL و BullMQ را انتخاب کردند.

---

## ۲. پروژه‌های بررسی‌شده

| #   | پروژه                                                   | نوع                               | زبان                 | لایسنس ثبت‌شده در پژوهش                                     | استقرار                                      | تمرکز اصلی                                    |
| --- | ------------------------------------------------------- | --------------------------------- | -------------------- | ----------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| 1   | **Antirion**                                            | گیت‌وی سازمانی                    | Rust، یک باینری      | Apache-2.0؛ همه‌ی فیچرها رایگان                             | فقط Self-hosted، تک‌نود یا کلاستر، Helm      | کارایی، حاکمیت، guardrail                     |
| 2   | **OmniRoute**                                           | گیت‌وی محلی/ابری                  | Node/TS، Electron    | MIT                                                         | npm، Docker، دسکتاپ، Termux، PWA، Cloud پولی | Providers، مسیریابی، فشرده‌سازی               |
| 3   | **9Router**                                             | گیت‌وی محلی برای ابزارهای کدنویسی | Node/TS              | MIT                                                         | npm، تونل Cloudflare                         | فال‌بک اشتراک/رایگان، صرفه‌جویی توکن          |
| 4   | **LiteLLM**                                             | Proxy و SDK                       | Python؛ Rust در beta | MIT؛ فیچرهای enterprise پولی                                | Docker، Helm، Terraform، PostgreSQL          | اکوسیستم جاافتاده، بیش از ۱۰۰ provider        |
| 5   | **Bifrost** (Maxim)                                     | گیت‌وی با کارایی بالا             | Go                   | Apache-2.0؛ فیچرهای enterprise پولی                         | Docker، باینری                               | کارایی، virtual keys، MCP                     |
| 6   | **Portkey Gateway**                                     | گیت‌وی/پلتفرم                     | TS                   | MIT؛ پلتفرم پولی؛ پژوهش Palo Alto را مالک معرفی می‌کند      | Node، Workers، Kubernetes، Cloud             | مسیریابی مبتنی بر config، بیش از ۵۰ guardrail |
| 7   | **new-api** (QuantumNous، نسخه‌ی گسترش‌یافته‌ی one-api) | گیت‌وی فروش API                   | Go + React           | AGPL/MIT\*                                                  | Docker، SQLite/MySQL/PG، ClickHouse          | **صورت‌حساب، شارژ، فروش اعتبار**              |
| 8   | **CLIProxyAPI**                                         | پروکسی حساب‌های OAuth             | Go                   | MIT                                                         | Docker، cluster                              | Codex، Claude Code، Gemini CLI، حساب‌های Grok |
| 9   | **Claude Code Router (CCR)**                            | control plane محلی برای ایجنت‌ها  | TS                   | MIT                                                         | npm، دسکتاپ، Docker                          | پروفایل ایجنت‌ها، مسیریابی شرطی               |
| 10  | **TensorZero**                                          | گیت‌وی، ارزیابی و بهینه‌سازی      | Rust                 | Apache-2.0؛ پژوهش آرشیو شدن آن را در May/June 2026 ثبت کرده | Docker                                       | A/B tests، evaluations، fine-tuning           |
| 11  | **Helicone AI Gateway**                                 | گیت‌وی و observability            | Rust                 | ناهمخوانی Apache/GPL در پژوهش                               | npx، Docker، Kubernetes                      | مسیریابی PeakEWMA، کش                         |
| 12  | **LLM Gateway** (theopenco)                             | گیت‌وی SaaS/self-hosted           | TS (Hono، Next.js)   | AGPLv3 و نسخه‌ی enterprise                                  | Docker image یکپارچه                         | الگوهای مونوریپو و multitenancy               |
| 13  | **OpenRouter**                                          | بازار SaaS بسته                   | مشخص نشده            | تجاری                                                       | فقط Cloud                                    | Credits، BYOK، provider routing               |
| 14  | **Kong / Envoy AI Gateway / agentgateway**              | افزونه‌های API gateway            | Lua، Go، Rust        | OSS و enterprise                                            | Kubernetes                                   | تیم‌های پلتفرم                                |

\* لایسنس new-api را پیش از استفاده‌ی مجدد از کد بررسی کنید.

> **محدودیت کارایی در پژوهش اصلی:** اعدادی مانند 0.5 ms برای Antirion و 11 microseconds برای Bifrost را خود سازنده‌ها گزارش کرده‌اند، با روش‌های متفاوت اندازه‌گیری شده‌اند و مستقیماً قابل مقایسه نیستند.

---

## ۳. فهرست ترکیبی فیچرها

کلید منابع: **A** = Antirion، **O** = OmniRoute، **N** = 9Router، **L** = LiteLLM، **B** = Bifrost، **P** = Portkey، **NA** = new-api، **C** = CLIProxyAPI، **R** = CCR، **T** = TensorZero، **H** = Helicone، **G** = LLM Gateway، **OR** = OpenRouter. `(ent)` یعنی نسخه‌ی enterprise.

اولویت‌های اولیه‌ی پژوهش: **P0** = MVP، **P1** = نسخه‌ی ۱، **P2** = بعداً. این اولویت‌های پژوهشی جایگزین برنامه‌ی اسپرینت بعدی نمی‌شوند.

### ۳.۱ سازگاری API و تبدیل فرمت

| فیچر                                                                             | منابع          | اولویت |
| -------------------------------------------------------------------------------- | -------------- | ------ |
| Endpoint سازگار با OpenAI Chat Completions                                       | همه            | P0     |
| OpenAI Responses API                                                             | O، NA، C، R    | P0     |
| Anthropic Messages API، شامل پشتیبانی از Claude Code                             | A، O، NA، C، R | P0     |
| Gemini generateContent / Interactions                                            | A، O، NA، C، R | P1     |
| Bedrock dialect ورودی                                                            | A              | P2     |
| تبدیل دوطرفه‌ی فرمت، شامل stream، tool call و reasoning                          | A، O، N، NA    | P0     |
| پاسخ‌های SSE به‌صورت streaming و غیر streaming                                   | همه            | P0     |
| WebSocket / Realtime API                                                         | NA، P، C       | P2     |
| `/v1/models` و کاتالوگ مدل                                                       | O، R           | P0     |
| Function calling، ابزارها، خروجی ساختاریافته (JSON Schema)                       | C، T، NA       | P0     |
| ورودی‌های چندرسانه‌ای: تصویر و فایل                                              | C، T، P        | P1     |
| پشتیبانی drop-in از SDKهای رسمی، LangChain و Vercel AI SDK با تغییر فقط base URL | A، B           | P0     |

### ۳.۲ انواع سرویس (Modalities)

| فیچر                                                                     | منابع    | اولویت |
| ------------------------------------------------------------------------ | -------- | ------ |
| Chat/LLM                                                                 | همه      | P0     |
| Embeddings                                                               | N، NA، T | P1     |
| Rerank                                                                   | NA       | P2     |
| TTS / STT / ترجمه                                                        | N، NA، P | P2     |
| تولید تصویر                                                              | N، NA، P | P2     |
| تولید ویدیو و تسک‌های ناهمگام (Midjourney، Suno، Runway) با پیگیری وضعیت | N، NA    | P2     |
| جستجوی وب به‌صورت سرویس (Tavily، Brave، Exa، Serper و غیره)              | N، O     | P2     |
| Web fetch (Firecrawl، Jina Reader)                                       | N        | P2     |
| Batch inference و Files API                                              | T، L     | P2     |
| Fusion: افزودن vision یا جستجوی وب به مدلی که آن را ندارد                | R        | P2     |

### ۳.۳ Providerها و روش‌های اتصال

| فیچر                                                                                                                                                                                               | منابع          | اولویت                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------- |
| Providerهای اصلی با API key: OpenAI، Anthropic، Gemini، Azure، Bedrock، Vertex، Mistral، Cohere، Groq، Together، Fireworks، DeepSeek، xAI، Cerebras، DeepInfra، Perplexity، OpenRouter، NVIDIA NIM | A، O، L        | P0                     |
| هر سرور سازگار با OpenAI (vLLM، Ollama، LM Studio، llama.cpp، SGLang، TGI)                                                                                                                         | همه            | P0                     |
| Providerهای ارزان چینی (GLM/Z.AI، Kimi، MiniMax، Qwen، SiliconFlow، Bailian)                                                                                                                       | N، O، R        | P1                     |
| **اشتراک‌های OAuth** (Claude Code، Codex، Gemini CLI، Copilot، Cursor، Kimi Code، Grok Build، Antigravity، Kiro)                                                                                   | O، N، C، L     | P1، با محدودیت‌ها      |
| احراز هویت با web-cookie (ChatGPT Web، Claude Web، Gemini Web)                                                                                                                                     | O، N           | پیشنهاد اولیه: حذف شود |
| مسیرهای رایگان و بدون کلید (Pollinations، OpenCode Free، Cloudflare AI)                                                                                                                            | O، N           | P2                     |
| چند اکانت یا چند کلید برای هر provider (credential pool)                                                                                                                                           | O، N، C، NA، R | P0                     |
| تعریف provider سفارشی از طریق UI/پلاگین                                                                                                                                                            | C، R، NA       | P1                     |
| Protocol probing، کشف خودکار مدل‌ها، تست اتصال                                                                                                                                                     | R، NA          | P1                     |
| وارد کردن ورودهای محلی ابزارها، مثل `~/.codex`                                                                                                                                                     | R              | P2                     |
| کاتالوگ قیمت مدل‌ها، همیشه به‌روز                                                                                                                                                                  | P، O           | P0                     |
| Model mapping و aliasها: نام مجازی به مدل واقعی                                                                                                                                                    | NA، R          | P0                     |

> **هشدار پژوهش:** استفاده از اشتراک‌های شخصی OAuth یا cookie پشت یک gateway چندکاربره ممکن است با شرایط خدمات آن سرویس‌ها در تضاد باشد و به محدودیت حساب منجر شود. پژوهش هشدار مشابهی را برای MITM bridge در 9Router یادآوری کرده بود. پیشنهاد آن این بود که چنین پشتیبانی‌ای فقط به‌صورت پلاگین اختیاری برای استفاده‌ی شخصی و با اعلان صریح در UI باشد، و MITM bridge و یکپارچه‌سازی web-cookie از هسته کنار گذاشته شوند. پیش از پیاده‌سازی هر یکپارچه‌سازی، شرایط قابل اعمال را دوباره بررسی کنید.

### ۳.۴ مسیریابی (Routing)

| فیچر                                                                                            | منابع          | اولویت |
| ----------------------------------------------------------------------------------------------- | -------------- | ------ |
| Priority / fill-first، مثلاً مصرف اول سهمیه‌ی اشتراک                                            | O، N           | P0     |
| Weighted split                                                                                  | A، O، P، H، NA | P0     |
| Round-robin و sticky round-robin                                                                | O، N، C        | P0     |
| Least-used / least-busy                                                                         | O، L           | P1     |
| Power-of-two-choices (P2C) و PeakEWMA مبتنی بر latency                                          | O، H           | P1     |
| Least-latency                                                                                   | A، H           | P1     |
| Least-cost / بهینه‌سازی هزینه                                                                   | A، O، H، P     | P1     |
| آگاه از headroom: ترجیح سهمیه‌ی باقی‌مانده‌ی بیشتر                                              | O              | P1     |
| آگاه از زمان ریست / پنجره‌ی ریست: در نظر گرفتن زمان ریست سهمیه                                  | O              | P1     |
| Last-known-good                                                                                 | O              | P1     |
| بهینه‌سازی context / context-relay: انتخاب بر اساس طول context                                  | O              | P1     |
| بهینه‌سازی کش: حفظ prompt cache نزد همان provider از طریق session affinity                      | O، NA          | P1     |
| Random / strict-random                                                                          | O              | P2     |
| Fusion / pipeline: ترکیب چند مدل                                                                | O              | P2     |
| **Classifier / مسیریابی لایه‌ای:** دسته‌بندی وظایف و انتخاب مدل                                 | A، C           | P1     |
| aliasهای خودکار: `auto`، `auto/coding`، `auto/fast`، `auto/cheap`، `auto/smart`، `auto/offline` | O              | P1     |
| امتیازدهی تطبیقی چندعاملی؛ پژوهش ۱۵ عامل را در OmniRoute ثبت کرده است                           | O، B(ent)      | P2     |
| **Combo / مدل مجازی:** زنجیره‌ای از مدل‌ها با استراتژی و fallback                               | O، N، R        | P0     |
| مسیریابی شرطی بر اساس header، body، tag یا metadata                                             | P، R، L        | P1     |
| سیاست‌های جداگانه برای تیم و پروژه، با گزارش سهم ترافیک هر قاعده                                | A              | P1     |
| Prefixها و بازنویسی درخواست                                                                     | R              | P1     |
| Channel affinity: اتصال کاربر به یک کانال                                                       | NA             | P1     |
| A/B tests، canary، adaptive bandits                                                             | T، P           | P2     |

### ۳.۵ تاب‌آوری (Resilience) — اولویت ویژه

| فیچر                                                                          | منابع          | اولویت |
| ----------------------------------------------------------------------------- | -------------- | ------ |
| fallback چندسطحی: اشتراک به API به ارزان به رایگان                            | O، N، A        | P0     |
| fallback بر اساس نوع خطا: 429، 5xx، timeout، content policy، context window   | P، L           | P0     |
| Retry با exponential backoff و jitter                                         | A، P، T        | P0     |
| **Request hedging:** ارسال به provider دوم وقتی اولی کند است                  | A              | P1     |
| **Circuit breaker برای هر provider:** حالت‌های closed، open و half-open probe | A، O           | P0     |
| Cooldown برای هر کلید یا اکانت، در حالی که بقیه‌ی اعتبارها ادامه می‌دهند      | O، L           | P0     |
| Model lockout: فقط مدلی که rate-limit شده کنار گذاشته شود، نه کل اتصال        | O              | P0     |
| Timeout جداگانه برای اتصال، first-token (TTFT) و کل درخواست                   | P، T           | P0     |
| غیرفعال و دوباره فعال کردن خودکار کانال بر اساس خطاها و تست دوره‌ای           | NA             | P0     |
| Health check فعال providerها                                                  | L، O           | P0     |
| توزیع ترافیک بین کلیدها برای کاهش فشار rate-limit                             | O، B           | P0     |
| اجرای چندنودی stateless با شمارنده‌های مشترک Valkey                           | A، NA          | P0     |
| Graceful shutdown و drain کردن streamهای باز                                  | بدون منبع مشخص | P0     |
| ادامه‌ی کار هنگام قطعی DB/Redis: کش محلی config و fail-open قابل تنظیم        | بدون منبع مشخص | P0     |
| بازیابی stream قطع‌شده، تا جایی که امکان‌پذیر است                             | بدون منبع مشخص | P2     |

### ۳.۶ کش و صرفه‌جویی توکن

| فیچر                                                                                                                                           | منابع      | اولویت |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| Exact cache در Redis، S3 یا حافظه، با max-age، max-stale و invalidation                                                                        | A، H، L    | P1     |
| **Semantic cache** برای هر مدل، تیم یا کلید، با vector store                                                                                   | A، O، B، P | P1     |
| هدر وضعیت کش مانند `X-...-Cache: HIT` و گزارش صرفه‌جویی                                                                                        | O، A       | P1     |
| حسابداری prompt cache خود provider: cache reads/writes                                                                                         | NA         | P0     |
| **فشرده‌سازی context:** حذف تکرار در session، فیلتر خروجی ابزارها (git diff، grep، ls، tree)، compaction جدولی، relevance pruning، LLMLingua-2 | O، N       | P1     |
| پروفایل‌های فشرده‌سازی (Lite، Standard، Aggressive، Ultra) که با header هر درخواست قابل تنظیم‌اند                                              | O          | P1     |
| حالت خروجی کوتاه (Caveman / terse) با چند سطح                                                                                                  | N، O       | P2     |
| Anthropic Context Editing و کنترل بودجه‌ی context                                                                                              | O          | P2     |
| Compression Studio (رابط آزمایش) و ارزیابی آفلاین                                                                                              | O          | P2     |

### ۳.۷ کلید، دسترسی و هویت

| فیچر                                                                          | منابع             | اولویت |
| ----------------------------------------------------------------------------- | ----------------- | ------ |
| Virtual / gateway key با مدل‌های مجاز، تاریخ انقضا، IP allowlist و محدودیت‌ها | A، L، B، P، NA، R | P0     |
| ذخیره‌ی رمزشده‌ی اعتبارهای provider (AES-256-GCM، envelope encryption)        | A، O              | P0     |
| یکپارچه‌سازی Vault/KMS (HashiCorp، AWS KMS)                                   | B(ent)            | P2     |
| سلسله‌مراتب **Org → Team → Project → Key → User**                             | A، L، B           | P0     |
| نقش‌های سفارشی و RBAC                                                         | A، P، NA          | P1     |
| SSO: OIDC، SAML، GitHub، Google                                               | A، L، B           | P1     |
| SCIM provisioning و همگام‌سازی directory                                      | A، B              | P2     |
| MFA: TOTP، WebAuthn، passkeys                                                 | A، NA             | P1     |
| مدیریت session ورود                                                           | NA                | P1     |
| Change requestها برای عملیات حساس، مانند تأیید چهار-چشم (four-eyes)           | A                 | P2     |
| Audit log کامل                                                                | A، L، P           | P1     |
| گروه‌های دسترسی به مدل                                                        | L                 | P1     |
| ورود OAuth برای کاربران نهایی (GitHub، Google، Telegram، Discord، OIDC)       | NA                | P1     |
| محدودیت دسترسی بر اساس IP و جغرافیا                                           | P(ent)            | P2     |
| شناسه‌های کاربر نهایی برای ردیابی                                             | L، B              | P1     |

### ۳.۸ بودجه، سهمیه و rate limit

| فیچر                                                                 | منابع      | اولویت |
| -------------------------------------------------------------------- | ---------- | ------ |
| محدودیت RPM، TPM، تعداد درخواست همزمان و تعداد تصویر                 | A، L، H، R | P0     |
| بودجه‌ی دلاری یا توکنی در سطوح org، team، project، key، user و model | A، L، B، H | P0     |
| بودجه‌های روزانه، هفتگی و ماهانه با ریست خودکار                      | L          | P0     |
| پیش‌بینی هزینه و تاریخ پیش‌بینی‌شده‌ی اتمام بودجه                    | A          | P1     |
| یک **ledger** پشت هر عدد هزینه                                       | A          | P0     |
| پیگیری سهمیه‌ی اشتراک و شمارش معکوس تا ریست                          | N، O       | P1     |
| سهم عادلانه بین اعضای تیم که یک اشتراک مشترک دارند                   | O          | P2     |
| حسابداری استخر سهمیه‌ی رایگان بدون شمارش دوباره                      | O          | P2     |
| هشدار رسیدن به آستانه‌ی بودجه در ۵۰٪، ۸۰٪ و ۱۰۰٪                     | L          | P1     |

### ۳.۹ صورت‌حساب و کسب درآمد

این مجموعه‌ی کامل در Antirion و OmniRoute شناسایی نشد. منبع اصلی new-api بود که به‌عنوان «پنل فروش API» توصیف شده است. مواردی که با علامت † مشخص شده‌اند از مستندات یا نسخه‌های قبلی آمده‌اند و پیش از پیاده‌سازی باید دوباره بررسی شوند.

| فیچر                                                                           | منابع                    | اولویت |
| ------------------------------------------------------------------------------ | ------------------------ | ------ |
| کیف پول کاربر / اعتبار پیش‌پرداخت                                              | NA، OR                   | P1     |
| شارژ آنلاین از طریق Stripe و †Epay؛ گزینه‌های ایرانی: زرین‌پال، IDPay، NextPay | NA†                      | P1     |
| کدهای هدیه یا شارژ برای استفاده                                                | NA†                      | P1     |
| پاداش معرفی و affiliate                                                        | NA†                      | P2     |
| پلن‌های اشتراکی                                                                | NA، G(ent)               | P2     |
| ضرایب قیمت‌گذاری بر اساس مدل، خروجی، گروه کاربری و کش                          | NA                       | P1     |
| قیمت‌گذاری به ازای هر درخواست برای تصویر و ویدیو                               | NA                       | P1     |
| قیمت‌گذاری پلکانی مبتنی بر عبارت (expression-based)                            | NA                       | P2     |
| بازار عمومی مدل‌ها با قیمت                                                     | NA، OR                   | P1     |
| Bring your own key (BYOK)                                                      | OR                       | P1     |
| فاکتور، صورت‌حساب ماهانه، خروجی CSV/PDF                                        | نمونه‌ی کامل شناسایی نشد | P2     |
| گزارش سود: هزینه‌ی خرید از provider در برابر درآمد فروش                        | فرصت تمایز               | P2     |

### ۳.۱۰ Guardrail و امنیت محتوا

| فیچر                                                                              | منابع      | اولویت |
| --------------------------------------------------------------------------------- | ---------- | ------ |
| تشخیص PII و secret، از جمله API keyها و توکن‌ها                                   | A، O، L، P | P1     |
| Regex و فهرست کلمات                                                               | A، P       | P1     |
| اعتبارسنجی خروجی با JSON Schema                                                   | A، P       | P1     |
| تشخیص prompt injection                                                            | O          | P1     |
| Moderation مستقل از provider                                                      | A، O       | P1     |
| LLM-as-judge                                                                      | A، T       | P2     |
| بررسی مجوز ابزارها (tool-permission)                                              | A          | P2     |
| اعمال بررسی روی درخواست‌ها، پاسخ‌ها و **stream**ها                                | A          | P1     |
| اقدام‌ها: block، redact با حفظ قالب، flag، divert                                 | A          | P1     |
| پلاگین‌های guardrail شخص ثالث؛ پژوهش بیش از ۴۰ مورد در Portkey ثبت کرده است       | P          | P2     |
| لاگ محتوا به‌صورت پیش‌فرض خاموش است؛ در صورت فعال بودن، PII باید mask یا hash شود | A          | P0     |

### ۳.۱۱ ایجنت‌ها، MCP و A2A

| فیچر                                                                                                   | منابع      | اولویت |
| ------------------------------------------------------------------------------------------------------ | ---------- | ------ |
| **MCP Gateway:** ثبت سرورهای MCP و اعمال کلیدها، بودجه‌ها و لاگ‌ها روی آن‌ها                           | A، L، B، P | P1     |
| سرور MCP مدیریتی خود gateway روی stdio، HTTP و SSE؛ پژوهش ۱۱۰ ابزار OmniRoute را ثبت کرده است          | O          | P2     |
| ارسال هویت کاربر به سرورهای MCP                                                                        | P          | P2     |
| MCP Code Mode                                                                                          | B          | P2     |
| **A2A:** Agent Card در `/.well-known` و JSON-RPC (`message/send`، `tasks/get`)                         | A، O، L    | P2     |
| پروفایل ایجنت‌ها (Claude Code، Codex، OpenCode و غیره) با override مدل و پیکربندی یک‌کلیکی             | R، N، O    | P1     |
| راهنمای نصب برای Claude Code، Codex، Cursor، Cline، Roo، Kilo، Continue، Aider، Goose، Windsurf و غیره | O، N       | P0     |
| افزونه‌ی VS Code برای افزودن مدل به picker                                                             | O          | P2     |
| حافظه‌ی گفتگو (FTS/vector) همراه با کنترل نگه‌داری                                                     | O          | P2     |
| رله‌ی ایجنت از طریق Telegram، Slack، Discord                                                           | R          | P2     |

### ۳.۱۲ Observability و تحلیل

| فیچر                                                                                                                     | منابع      | اولویت |
| ------------------------------------------------------------------------------------------------------------------------ | ---------- | ------ |
| لاگ هر درخواست: مسیر انتخاب‌شده، **هر تلاش و دلیل شکست آن**، توکن‌ها، هزینه، وضعیت کش، نتیجه‌ی guardrail، latency و TTFT | A، R، L    | P0     |
| Tracing ایجنت و tool-call                                                                                                | R          | P1     |
| Prometheus metrics                                                                                                       | A، B، T، L | P0     |
| OpenTelemetry: traces، metrics، logs                                                                                     | A، H، T، L | P1     |
| Sinkهای لاگ خارجی: Langfuse، Datadog، S3، Kafka                                                                          | A، L       | P2     |
| دیتابیس لاگ جداگانه (ClickHouse)                                                                                         | NA         | P1     |
| Replay درخواست‌های قبلی با مدل یا prompt متفاوت                                                                          | T          | P2     |
| ساخت dataset از ترافیک واقعی، همراه با ارزیابی و feedback                                                                | T          | P2     |
| هشدار از طریق Slack، Telegram، ایمیل و webhook                                                                           | L، NA†     | P1     |

### ۳.۱۳ پیکربندی و عملیات

| فیچر                                                             | منابع    | اولویت                                    |
| ---------------------------------------------------------------- | -------- | ----------------------------------------- |
| پیکربندی اعلانی YAML که از طریق فایل، API یا کنسول ویرایش می‌شود | A، H     | P1                                        |
| اعتبارسنجی schema، **diff، نسخه‌بندی و rollback**                | A        | P1                                        |
| Hot reload بدون ری‌استارت                                        | C، A     | P0                                        |
| GitOps                                                           | T        | P2                                        |
| ویزارد راه‌اندازی اولیه                                          | NA       | P0                                        |
| پروکسی خروجی SOCKS5/HTTP در سطح کل سیستم، provider یا اتصال      | O، N     | P0؛ به‌ویژه برای استقرار در ایران مهم است |
| Proxy pool، چرخش IP و relay                                      | N، O     | P1                                        |
| تونل دسترسی از راه دور (Cloudflare Tunnel)                       | N        | P2                                        |
| کنترل egress برای IPv4 و IPv6                                    | O        | P2                                        |
| بین‌المللی‌سازی، از جمله **فارسی و RTL**                         | NA       | P0                                        |
| Playground مدل                                                   | NA، T، G | P1                                        |
| سیستم middleware / پلاگین                                        | B، NA، R | P2                                        |
| Management API کامل که همه‌ی عملیات UI را پوشش دهد               | C، A     | P0                                        |
| SDK قابل embed                                                   | C        | P2                                        |

### ۳.۱۴ استقرار و زنجیره‌ی تأمین

| فیچر                                                                          | منابع    | اولویت |
| ----------------------------------------------------------------------------- | -------- | ------ |
| تصاویر Docker بدون سیستم‌عامل کامل (distroless) و غیر-root برای amd64 و arm64 | A، O، NA | P0     |
| Docker Compose برای استقرار تک‌نود و کلاستری                                  | A، C     | P0     |
| Helm chart با HPA autoscaling                                                 | A، L     | P1     |
| حالت شخصی سبک تک‌نود با ذخیره‌سازی embedded                                   | A، O     | P2     |
| npm، برنامه‌ی دسکتاپ Electron/Tauri، PWA                                      | O، N، R  | P2     |
| SBOM، امضاهای Sigstore، SLSA provenance                                       | A        | P2     |
| Benchmark harness منتشرشده                                                    | A، H     | P1     |

---

## ۴. ماتریس مقایسه‌ی فیچرها

راهنما: ✅ دارد، ⚠️ جزئی یا فقط در نسخه‌ی پولی، ❌ ندارد یا گزارش نشده. این‌ها ارزیابی‌های اولیه‌ی پژوهش هستند، نه مشخصات تأییدشده‌ی فعلی محصول.

| قابلیت                                | Antirion | OmniRoute     | 9Router | LiteLLM | Bifrost | Portkey | new-api | CLIProxy | CCR | **هدف DiRouter** |
| ------------------------------------- | -------- | ------------- | ------- | ------- | ------- | ------- | ------- | -------- | --- | ---------------- |
| OpenAI / Anthropic / Gemini API       | ✅       | ✅            | ✅      | ✅      | ✅      | ✅      | ✅      | ✅       | ✅  | ✅               |
| تبدیل فرمت                            | ✅       | ✅            | ✅      | ✅      | ✅      | ✅      | ✅      | ✅       | ✅  | ✅               |
| تعداد provider                        | ~17      | 350+          | 60+     | 100+    | 23+     | 45+     | ~30+    | ~10      | ~10 | 50+              |
| اشتراک OAuth                          | ❌       | ✅            | ✅      | ⚠️      | ❌      | ❌      | ❌      | ✅       | ⚠️  | ⚠️ پلاگین        |
| تصویر، صوت، ویدیو                     | ❌       | ⚠️            | ✅      | ✅      | ⚠️      | ✅      | ✅      | ❌       | ❌  | ✅               |
| Combo / مدل مجازی                     | ⚠️       | ✅            | ✅      | ⚠️      | ❌      | ✅      | ⚠️      | ❌       | ✅  | ✅               |
| تعداد استراتژی‌های routing            | ~7       | 19            | 2       | ~5      | ~2      | ~3      | ~2      | 1        | ~2  | 15+              |
| Classifier routing                    | ✅       | ✅ auto       | ❌      | ❌      | ❌      | ⚠️      | ❌      | ⚠️       | ⚠️  | ✅               |
| Circuit breaker                       | ✅       | ✅            | ❌      | ⚠️      | ✅      | ❌      | ⚠️      | ❌       | ❌  | ✅               |
| Request hedging                       | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |
| Cooldown اعتبار / lockout مدل         | ⚠️       | ✅            | ⚠️      | ✅      | ⚠️      | ❌      | ✅      | ⚠️       | ⚠️  | ✅               |
| Exact cache                           | ✅       | ⚠️            | ❌      | ✅      | ⚠️      | ✅      | ❌      | ❌       | ❌  | ✅               |
| Semantic cache                        | ✅       | ✅            | ❌      | ✅      | ✅      | ⚠️      | ❌      | ❌       | ❌  | ✅               |
| فشرده‌سازی context                    | ❌       | ✅ 12 engines | ✅ RTK  | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |
| Virtual keys / بودجه‌های سلسله‌مراتبی | ✅       | ⚠️            | ❌      | ✅      | ✅      | ✅      | ✅      | ❌       | ⚠️  | ✅               |
| Rate limits (RPM/TPM/cost)            | ✅       | ✅            | ❌      | ✅      | ✅      | ⚠️      | ⚠️      | ❌       | ✅  | ✅               |
| SSO / SCIM                            | ✅       | ❌            | ❌      | ⚠️      | ⚠️      | ⚠️      | ⚠️ OIDC | ❌       | ❌  | ✅               |
| MFA / passkey                         | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ✅      | ❌       | ❌  | ✅               |
| RBAC / audit                          | ✅       | ❌            | ❌      | ⚠️      | ⚠️      | ✅      | ⚠️      | ❌       | ❌  | ✅               |
| **صورت‌حساب / شارژ**                  | ❌       | ⚠️ cloud      | ❌      | ❌      | ❌      | ❌      | ✅      | ❌       | ❌  | ✅               |
| Guardrailها                           | ✅       | ✅            | ❌      | ✅      | ⚠️      | ✅      | ❌      | ❌       | ❌  | ✅               |
| MCP Gateway                           | ✅       | ✅            | ❌      | ✅      | ✅      | ✅      | ❌      | ❌       | ✅  | ✅               |
| A2A                                   | ✅       | ✅            | ❌      | ✅      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅ P2            |
| Prometheus / OpenTelemetry            | ✅       | ❌            | ❌      | ✅      | ✅      | ⚠️      | ❌      | ❌       | ❌  | ✅               |
| داشبورد تحلیلی                        | ✅       | ✅            | ⚠️      | ✅      | ✅      | ⚠️      | ✅      | ❌       | ✅  | ✅++             |
| Diff / rollback پیکربندی              | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |
| Proxy خروجی / pool                    | ❌       | ✅            | ✅      | ⚠️      | ❌      | ❌      | ✅      | ⚠️       | ❌  | ✅               |
| Clustering / HA                       | ✅       | ⚠️            | ❌      | ✅      | ⚠️      | ✅      | ✅      | ✅       | ❌  | ✅               |
| Helm / Kubernetes                     | ✅       | ❌            | ❌      | ✅      | ⚠️      | ✅      | ⚠️      | ❌       | ❌  | ✅               |
| فارسی / RTL                           | ❌       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |

---

## ۵. طراحی تاب‌آوری پیشنهادی DiRouter

اصل اول: **data plane نباید به control plane وابسته باشد.** قطع شدن PostgreSQL، NestJS یا داشبورد نباید ترافیک جاری را مختل کند.

1. **جداسازی data plane و control plane.** gateway پیکربندی را از control plane دریافت می‌کند، یک snapshot نسخه‌دار را در حافظه و روی دیسک نگه می‌دارد، و به‌روزرسانی‌ها را از طریق Valkey pub/sub یا long polling می‌گیرد. در زمان قطعی control plane، با آخرین پیکربندی معتبر ادامه می‌دهد.
2. **gatewayهای stateless با شمارنده‌های توزیع‌شده.** rate limit و بودجه در Valkey با sliding window یا GCRA و Lua script پیاده‌سازی می‌شوند. **fallback محلی:** سهمیه بین نودها تقسیم شود و وقتی Valkey در دسترس نیست، محدودسازی داخل حافظه انجام شود. حالت fail-open یا fail-closed برای هر tenant قابل تنظیم باشد.
3. **حسابداری ناهمگام.** مصرف لحظه‌ای در Valkey ثبت می‌شود (برای کنترل بودجه)، سپس رویدادها وارد صف می‌شوند (NATS JetStream یا Redis Streams) و از آنجا در ledger روی PostgreSQL و لاگ‌ها در ClickHouse ذخیره می‌شوند. مسیر درخواست هرگز منتظر نوشتن در دیتابیس نمی‌ماند. یک **idempotency key** از شمارش دوباره‌ی هزینه جلوگیری می‌کند؛ یک outbox محلی روی دیسک برای زمان قطعی صف در نظر گرفته شده است. MVP پذیرفته‌شده بعداً BullMQ و لاگ‌های PostgreSQL را انتخاب کرد.
4. **سه لایه‌ی جداسازی خطا، بر اساس الگوی OmniRoute:** circuit breaker برای هر provider، cooldown برای هر کلید، و lockout برای هر مدل؛ همراه با half-open probe و backoff تطبیقی.
5. **Hedging و timeoutها:** timeout جداگانه برای اتصال، TTFT و idle بودن stream. اگر TTFT از p95 بیشتر شود، می‌توان یک hedge به provider دوم فرستاد؛ فقط برای درخواست‌های idempotent یا با یک hedge budget مشخص.
6. **failover امن برای stream:** تا پیش از ارسال اولین بایت به کلاینت، fallback کامل مجاز است. پس از ارسال بخشی از پاسخ، یک خطای استاندارد برگردانده می‌شود. ادامه‌ی stream بین providerهای مختلف یک کار آزمایشی P2 است.
7. **Bulkhead:** connection poolها و محدودیت‌های concurrency جداگانه برای هر provider و هر tenant، تا یک provider کند یا یک مشتری پرمصرف کل سیستم را از کار نیندازد.
8. **پیشنهاد زیرساخت:** PostgreSQL با Patroni یا CloudNativePG (primary/replica) و PgBouncer؛ Valkey Sentinel یا Cluster؛ ClickHouse در ابتدا تک‌نود؛ replicaهای gateway پشت load balancer، با PodDisruptionBudget، readiness و liveness probe و graceful drain برای SSE.
9. **تست Chaos و تست بار:** k6 یا vegeta همراه با یک mock provider که در CI خطاهای 429، 5xx و latency تصادفی تولید می‌کند. SLOهای پیشنهادی: overhead در p99 کمتر از ۵ ms و دسترس‌پذیری ۹۹٫۹۵٪.

---

## ۶. داشبورد عملی — صفحات پیشنهادی

ترکیبی از Overview و لاگ‌های تلاش‌به‌تلاش Antirion، تب‌های Health و Costs از OmniRoute، marketplace مدل و playground از new-api، و request diagnostics از CCR.

| صفحه                            | محتوا                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                    | هزینه، درخواست‌ها، توکن‌ها، latency در p50/p95/p99، TTFT، نرخ خطا و cache-hit، صرفه‌جویی (کش، فشرده‌سازی، مسیرهای رایگان)، مدل‌ها و تیم‌های برتر، **headroom هر provider** |
| **Live / Realtime**             | جریان زنده‌ی درخواست‌ها (WebSocket)، RPS فعلی، درخواست‌های در حال اجرا، نقشه‌ی وضعیت providerها                                                                            |
| **Health**                      | وضعیت circuit breakerهای providerها، کلیدهای در cooldown، مدل‌های قفل‌شده و زمان بازگشایی آن‌ها، تاریخچه‌ی incidentها و uptime هر provider                                 |
| **Requests (Log Explorer)**     | فیلتر بر اساس کلید/تیم/مدل/وضعیت/هزینه/latency؛ جزئیات درخواست با timeline تلاش‌ها، دلیل شکست، نتیجه‌ی guardrail، وضعیت کش، body اختیاری، و replay در playground           |
| **Costs & Budgets**             | هزینه بر اساس org/team/project/key/user/model، پیش‌بینی و تاریخ اتمام بودجه، ledger، تفکیک اشتراک/رایگان/پولی، خروجی CSV                                                   |
| **Quotas**                      | سهمیه‌ی اکانت و اشتراک، شمارش معکوس تا ریست، میزان استفاده                                                                                                                 |
| **Providers & Credentials**     | wizard افزودن provider، تست اتصال، کشف مدل، چند اعتبار برای هر provider، تنظیمات proxy برای هر اتصال                                                                       |
| **Models / Catalog**            | قیمت‌ها، پنجره‌ی context، قابلیت‌ها، aliasها و mappingها، بازار عمومی مدل                                                                                                  |
| **Routing / Combos**            | ویرایشگر drag-and-drop برای زنجیره‌ی fallback و استراتژی، **routing simulator**، سهم ترافیک هر قاعده                                                                       |
| **Keys & Access**               | virtual keyها، مدل‌های مجاز، محدودیت‌ها، انقضا، IP allowlist، چرخش کلید                                                                                                    |
| **Org / Teams / Users / Roles** | سلسله‌مراتب، RBAC، SSO و SCIM، دعوت                                                                                                                                        |
| **Billing**                     | کیف پول، شارژ، کدهای هدیه، پلن‌ها، فاکتور، قیمت گروه‌ها، گزارش سود                                                                                                         |
| **Guardrails**                  | policyها، تست زنده، آمار block و redact                                                                                                                                    |
| **Cache & Compression**         | نرخ hit، صرفه‌جویی، پاک‌سازی کش، Compression Studio                                                                                                                        |
| **MCP & Agents**                | ثبت سرورهای MCP، دسترسی و لاگ ابزارها، پروفایل ایجنت‌ها با snippet آماده برای Claude Code و Codex                                                                          |
| **Playground**                  | مقایسه‌ی کنار هم مدل‌ها با هزینه و latency                                                                                                                                 |
| **Config**                      | ویرایش YAML با اعتبارسنجی، diff، تاریخچه، rollback، change requestها                                                                                                       |
| **Alerts**                      | قوانین بودجه، خطا و قطعی providerها و کانال‌های Telegram، Slack، email و webhook                                                                                           |
| **Audit Log**                   | هر تغییر پیکربندی به همراه diff                                                                                                                                            |

پیشنهادهای UX:

- RTL و LTR کامل، تقویم شمسی و میلادی، تم روشن و تیره.
- بازه‌ی زمانی سراسری، drill-down از نمودار به لاگ، لینک‌های قابل اشتراک‌گذاری برای فیلترها.
- Command palette (`Cmd+K`).

---

## ۷. پیشنهاد فنی اولیه

### ۷.۱ ارزیابی NestJS + React + PostgreSQL

| لایه                                                          | انتخاب اولیه کاربر | ارزیابی پژوهش                                                                                                                                                                                                                       | پیشنهاد اولیه                                                                                                                             |
| ------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane:** Admin API، auth، billing، config، گزارش‌ها | NestJS             | تطابق قوی: ماژول‌ها، DI، guardها و RBAC، OpenAPI، اکوسیستم                                                                                                                                                                          | **NestJS با Fastify adapter**                                                                                                             |
| **Data plane:** مسیر داغ درخواست‌های LLM                      | NestJS             | پژوهش، DI/interceptorها و pipeهای هر درخواست و GC و اجرای تک‌رشته‌ای Node را در ده‌ها هزار stream همزمان، ریسک latency دم‌بلند و مصرف بیشتر حافظه می‌دانست. این پژوهش gatewayهای Rust/Go را با پروژه‌های محلی Node مقایسه کرده بود. | **Go**، با Rust به‌عنوان جایگزین؛ بعداً با ADR-001 جایگزین شد                                                                             |
| **Frontend**                                                  | React              | مناسب                                                                                                                                                                                                                               | React + Vite + TypeScript، TanStack Router/Query، shadcn/ui (Radix) + Tailwind با RTL، ECharts یا Recharts، TanStack Table، react-i18next |
| **Primary database**                                          | PostgreSQL         | تطابق قوی برای کاربران، کلیدها، config و ledger                                                                                                                                                                                     | **PostgreSQL 17** + PgBouncer                                                                                                             |
| **Logs and analytics**                                        | PostgreSQL         | پژوهش مشکلات احتمالی را با میلیون‌ها ردیف خام لاگ در روز و aggregateهای سریع پیش‌بینی کرد                                                                                                                                           | **ClickHouse**، مانند new-api؛ TimescaleDB برای حجم کم هم گزینه‌ی اولیه‌ی دیگری بود                                                       |
| **Counters, cache, pub/sub**                                  | مشخص نشده          | لازم است                                                                                                                                                                                                                            | **Valkey**، یک فورک باز از Redis                                                                                                          |
| **Event queue**                                               | مشخص نشده          | لازم است                                                                                                                                                                                                                            | **NATS JetStream**، یا در ابتدا Redis Streams                                                                                             |
| **Vectors for semantic cache/memory**                         | مشخص نشده          | لازم است                                                                                                                                                                                                                            | **pgvector** روی PostgreSQL؛ در مقیاس بالاتر Qdrant                                                                                       |

### ۷.۲ چرا Go برای data plane؟

منطق اصلی پژوهش این بود:

- Overhead زیر میلی‌ثانیه و latency دم‌بلند پایدار، با استناد به Bifrost به‌عنوان نمونه‌ی Go.
- Goroutineها برای تعداد زیادی stream همزمان SSE مناسب‌اند و `net/http` و `httputil` بالغ هستند.
- CLIProxyAPI و new-api نمونه‌هایی از translatorها و executorها در Go هستند.
- یادگیری Go برای تیم TypeScript ساده‌تر از Rust است. Rust عمدتاً برای یک چالش مستقیم کارایی در برابر Antirion پیشنهاد شده بود.
- **اگر تیم فقط TypeScript می‌داند،** گزینه‌ی دیگر این بود که data plane به‌صورت یک سرویس جدا با Node + Fastify یا uWebSockets خالص (بدون Nest) ساخته شود، با رابط پایدار که بعداً بتوان آن را با Go جایگزین کرد. پژوهش همچنان برای هدف مقیاس بالا، Go را ترجیح می‌داد.

این‌ها پیشنهادهای طراحی بودند، نه نتایج اندازه‌گیری‌شده‌ی DiRouter. ADR-001 بعداً NestJS روی Fastify را همراه با قواعد سخت‌گیرانه برای مسیر داغ و گزینه‌ی بازنویسی مبتنی بر benchmark انتخاب کرد.

### ۷.۳ ساختار مونوریپوی پیشنهادی اولیه

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

- ابزار مونوریپو: **pnpm workspaces + Turborepo**، یا **Nx** با پلاگین Go.
- ORM در NestJS: **Drizzle** یا **Prisma**. تجربه‌ی موجود تیم با Prisma از نگه داشتن آن پشتیبانی می‌کرد. migrationها باید از یک منبع واحد اجرا شوند.
- قرارداد بین Go و TS: snapshotهای پیکربندی به‌صورت JSON با یک schema مشترک. ارتباط داخلی می‌تواند با gRPC یا HTTP و به‌علاوه‌ی Valkey pub/sub انجام شود.

ساختار واقعی مخزن با TypeScript در [README پروژه](../../../README.md) مستند شده است.

---

## ۸. نقشه‌ی راه اولیه‌ی پیشنهادی

| فاز          | محدوده                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MVP (P0)** | APIهای OpenAI و Anthropic و تبدیل بین آن‌ها، حدود ۱۵ provider اصلی به‌علاوه‌ی سرورهای OpenAI-compatible، combo و fallback چندسطحی، circuit breaker، cooldown، lockout، retry و timeout، virtual keys، org/team/project، rate limit و بودجه، ledger، لاگ درخواست‌ها، proxy خروجی، صفحات Overview، Health، Requests، Providers، Keys و Combos، فارسی و RTL، Docker Compose |
| **v1 (P1)**  | APIهای کامل Gemini و Responses، مسیریابی latency/cost/headroom/classifier، hedging، کش exact و semantic، فشرده‌سازی RTK و dedup، SSO/MFA/RBAC/audit، guardrailها، MCP gateway، صورت‌حساب (کیف پول، درگاه، کد هدیه، ضرایب قیمت)، ClickHouse، OTel و Prometheus، Helm، diff و rollback پیکربندی، playground، هشدارها                                                       |
| **v2 (P2)**  | تصویر، صوت، ویدیو و جستجوی کامل، A2A، حافظه، SCIM، پلاگین‌ها، A/B و ارزیابی‌ها، افزونه‌ی VS Code، دسکتاپ، پلاگین‌های اختیاری اشتراک OAuth همراه با اعلان شرایط، SBOM و امضا                                                                                                                                                                                              |

---

## ۹. تصمیم‌های درخواست‌شده در پژوهش

1. **مدل کسب‌وکار:** فقط self-hosting سازمانی مانند Antirion، یا یک پنل فروش API مانند new-api و OpenRouter هم؟ این انتخاب وزن کار billing را تعیین می‌کند.
2. **اشتراک‌های OAuth و web-cookie:** حذف شوند، به‌صورت پلاگین اختیاری ارائه شوند، یا با درنظر گرفتن شرایط سرویس، در هسته قرار گیرند؟
3. **زبان data plane:** Go، Rust یا Node خالص؟ پژوهش Go را ترجیح می‌داد؛ ADR-001 انتخاب نهایی پذیرفته‌شده‌ی بعدی را ثبت کرده است.
4. **درگاه‌های پرداخت:** ایرانی، بین‌المللی یا هر دو؟

---

## منابعی که پژوهش ثبت کرده است

- [Antirion](https://antirion.ai/)
- [وب‌سایت OmniRoute](https://www.omniroute.online/) و [مخزن](https://github.com/cheaper-inference/OmniRoute)
- [وب‌سایت 9Router](https://9router.com/) و [مخزن](https://github.com/decolua/9router)
- [مستندات proxy مربوط به LiteLLM](https://docs.litellm.ai/docs/simple_proxy)
- [مخزن Bifrost](https://github.com/maximhq/bifrost)
- [مخزن Portkey Gateway](https://github.com/Portkey-AI/gateway)
- [مخزن new-api](https://github.com/QuantumNous/new-api) و [مستندات](https://docs.newapi.ai/)
- [مخزن CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [مخزن Claude Code Router](https://github.com/musistudio/claude-code-router)
- [مخزن TensorZero](https://github.com/tensorzero/tensorzero)
- [مخزن Helicone AI Gateway](https://github.com/Helicone/ai-gateway)
- [مخزن LLM Gateway](https://github.com/theopenco/llmgateway)
- [Maxim: جایگزین‌های Portkey](https://www.getmaxim.ai/articles/top-5-portkey-alternatives-in-2026/)
- [LLM Gateway: جایگزین‌های LiteLLM](https://llmgateway.io/blog/litellm-alternatives)
- [Coworker: جایگزین‌های LiteLLM](https://coworker.ai/blog/litellm-alternatives)
