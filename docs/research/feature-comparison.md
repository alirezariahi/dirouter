[English](feature-comparison.md) · [فارسی](feature-comparison.fa.md)

# DiRouter — competitor comparison, full feature list, and architecture proposal

> Research date: 17 Aban 1405 (2026-11-07)
> Status: research and design only; no code has been written yet.

---

## 1. Executive summary

- Each of the three main projects is strong in one area:
  - **Antirion:** an enterprise gateway written in Rust, focused on speed, governance and access (SSO, SCIM, RBAC, audit), guardrails, and clustering on Postgres and Valkey.
  - **OmniRoute:** a local gateway with the largest number of providers (350+), 19 routing strategies, context compression, memory, MCP, and A2A.
  - **9Router:** a lightweight tool for developers, with three-tier fallback (subscription → cheap → free), token savings, and nine service types: chat, embeddings, TTS, STT, images, video, search, and fetch.
- **None of them has every capability:** Antirion's enterprise controls, OmniRoute's provider and routing breadth, and **billing and credit sales**, which exist only in new-api.
- The DiRouter opportunity is one product in one monorepo, with a **fast, resilient data plane**, a **complete control plane** (users, teams, budgets, billing), and a **strong operations dashboard**.
- **Technical proposal:** NestJS + React + PostgreSQL is a fully suitable choice for the control plane and dashboard. However, **the request hot path (data plane) is better written in Go** (see section 7). Alongside Postgres, we also need **Valkey/Redis** and **ClickHouse**.

---

## 2. Projects reviewed

| #   | Project                                                | Type                                  | Language              | License                                       | Deployment                                     | Main focus                                        |
| --- | ------------------------------------------------------ | ------------------------------------- | --------------------- | --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| 1   | **Antirion**                                           | Enterprise gateway                    | Rust, one binary      | Apache-2.0; all features free                 | Self-hosted only, single node or cluster, Helm | Speed, governance, guardrails                     |
| 2   | **OmniRoute**                                          | Local and cloud gateway               | Node/TS, Electron     | MIT                                           | npm, Docker, desktop, Termux, PWA, paid Cloud  | Providers, routing, compression                   |
| 3   | **9Router**                                            | Local gateway for coding tools        | Node/TS               | MIT                                           | npm, Cloudflare tunnel                         | Subscription/free fallback, token savings         |
| 4   | **LiteLLM**                                            | Proxy and SDK                         | Python (Rust in beta) | MIT; paid Enterprise section                  | Docker, Helm, Terraform, Postgres              | Mainstream standard, 100+ providers               |
| 5   | **Bifrost** (Maxim)                                    | High-speed gateway                    | Go                    | Apache-2.0; paid Enterprise section           | Docker, binary                                 | Speed, virtual keys, MCP                          |
| 6   | **Portkey Gateway**                                    | Gateway and platform                  | TS                    | MIT; paid platform (current owner: Palo Alto) | Node, Workers, K8s, Cloud                      | Config-based routing, 50+ guardrails              |
| 7   | **new-api** (QuantumNous, an expanded one-api version) | API sales gateway                     | Go + React            | AGPL/MIT\*                                    | Docker, SQLite/MySQL/PG, ClickHouse            | **Billing, top-ups, credit sales**                |
| 8   | **CLIProxyAPI**                                        | OAuth-account proxy                   | Go                    | MIT                                           | Docker, cluster                                | Codex, Claude Code, Gemini CLI, and Grok accounts |
| 9   | **Claude Code Router (CCR)**                           | Local control plane for agents        | TS                    | MIT                                           | npm, desktop, Docker                           | Agent profiles, conditional routing               |
| 10  | **TensorZero**                                         | Gateway, evaluation, and optimization | Rust                  | Apache-2.0 (**archived in Khordad 1405**)     | Docker                                         | A/B tests, evaluations, fine-tuning               |
| 11  | **Helicone AI Gateway**                                | Gateway and observability             | Rust                  | Apache/GPL (inconsistent)                     | npx, Docker, K8s                               | PeakEWMA routing, caching                         |
| 12  | **LLM Gateway** (theopenco)                            | SaaS and self-hosted gateway          | TS (Hono, Next.js)    | AGPLv3 and EE                                 | Unified Docker image                           | Monorepo and multi-tenant patterns                |
| 13  | **OpenRouter**                                         | Closed SaaS marketplace               | —                     | Commercial                                    | Cloud only                                     | Credits, BYOK, provider routing                   |
| 14  | **Kong / Envoy AI Gateway / agentgateway**             | Plugins on API gateways               | Lua, Go, Rust         | OSS and Enterprise                            | K8s                                            | Platform teams                                    |

\* Re-check the license of new-api before reusing any of its code.

> **Note:** performance figures (such as 0.5 ms for Antirion or 11 µs for Bifrost) were reported by the vendors themselves, each measured with a different method, so they are not directly comparable.

---

## 3. Combined feature inventory

Source key: **A** = Antirion, **O** = OmniRoute, **N** = 9Router, **L** = LiteLLM, **B** = Bifrost, **P** = Portkey, **NA** = new-api, **C** = CLIProxyAPI, **R** = CCR, **T** = TensorZero, **H** = Helicone, **G** = LLM Gateway, **OR** = OpenRouter. `(ent)` means the Enterprise edition.

Priorities: **P0** = MVP, **P1** = version 1, **P2** = later. The subsequent sprint plan supersedes these research priorities.

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

> **Legal risk:** using personal OAuth or cookie subscriptions behind a multi-user gateway usually conflicts with those services' terms and can lead to account bans. The research also noted that 9Router itself warns about its MITM bridge. Its recommendation was to keep such support as an optional personal-use plugin with a clear notice in the UI, and to exclude the MITM bridge and web-cookie integration from the core. Check the applicable terms before implementing any such integration.

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
| Headroom-aware: prefer the account with more remaining quota                                      | O              | P1       |
| Reset-aware / reset-window: account for quota reset time                                          | O              | P1       |
| Last-known-good                                                                                   | O              | P1       |
| Context-optimized / context-relay: choose by context length                                       | O              | P1       |
| Cache-optimized: keep the provider's prompt cache through session affinity                        | O, NA          | P1       |
| Random / strict-random                                                                            | O              | P2       |
| Fusion / pipeline: combine several models                                                         | O              | P2       |
| **Classifier / tiered routing:** classify the task type and choose a model                        | A, C           | P1       |
| Automatic aliases: `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/smart`, `auto/offline` | O              | P1       |
| Adaptive multi-factor scoring; the research recorded 15 factors in OmniRoute                      | O, B(ent)      | P2       |
| **Combo / virtual model:** a chain of models with a strategy and fallback                         | O, N, R        | P0       |
| Conditional routing by header, body, tag, or metadata                                             | P, R, L        | P1       |
| Separate team/project policies, with traffic-share reporting per rule                             | A              | P1       |
| Prefixes and request rewriting                                                                    | R              | P1       |
| Channel affinity: pin a user to one channel                                                       | NA             | P1       |
| A/B tests, canaries, adaptive bandits                                                             | T, P           | P2       |

### 3.5 Resilience — special priority

| Feature                                                                             | Sources        | Priority |
| ----------------------------------------------------------------------------------- | -------------- | -------- |
| Multi-level fallback: subscription → API → cheap → free                             | O, N, A        | P0       |
| Error-based fallback: 429, 5xx, timeout, content policy, context window             | P, L           | P0       |
| Retry with exponential backoff and jitter                                           | A, P, T        | P0       |
| **Request hedging:** send to a second provider when the first is slow               | A              | P1       |
| **Per-provider circuit breaker:** closed, open, half-open probes                    | A, O           | P0       |
| Per-key or per-account cooldown while other credentials keep working                | O, L           | P0       |
| Model lockout: block only the rate-limited model, not the whole connection          | O              | P0       |
| Separate timeouts for connect, first token (TTFT), and the whole request            | P, T           | P0       |
| Automatic channel disable and re-enable based on errors and periodic tests          | NA             | P0       |
| Active provider health checks                                                       | L, O           | P0       |
| Spread traffic across keys to reduce rate-limit pressure                            | O, B           | P0       |
| Stateless multi-node operation with shared Valkey counters                          | A, NA          | P0       |
| Graceful shutdown and draining of open streams                                      | Not attributed | P0       |
| Keep working during DB/Redis outages: local config cache and configurable fail-open | Not attributed | P0       |
| Recover an interrupted stream, where feasible                                       | Not attributed | P2       |

### 3.6 Caching and token savings

| Feature                                                                                                                                              | Sources    | Priority |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Exact cache in Redis, S3, or memory, with max-age, max-stale, and invalidation                                                                       | A, H, L    | P1       |
| **Semantic cache** per model, team, or key, using a vector store                                                                                     | A, O, B, P | P1       |
| Cache-status header such as `X-...-Cache: HIT`, and savings reporting                                                                                | O, A       | P1       |
| Provider prompt-cache accounting: cache reads and writes                                                                                             | NA         | P0       |
| **Context compression:** session deduplication, tool-output filtering (git diff, grep, ls, tree), tabular compaction, relevance pruning, LLMLingua-2 | O, N       | P1       |
| Compression profiles (Lite, Standard, Aggressive, Ultra), configurable per request header                                                            | O          | P1       |
| Short-output mode (Caveman / terse), with several levels                                                                                             | N, O       | P2       |
| Anthropic Context Editing and a context-budget dial                                                                                                  | O          | P2       |
| Compression Studio UI and offline evaluations                                                                                                        | O          | P2       |

### 3.7 Keys, access, and identity

| Feature                                                                       | Sources           | Priority |
| ----------------------------------------------------------------------------- | ----------------- | -------- |
| Virtual / gateway keys with allowed models, expiry, IP allowlists, and limits | A, L, B, P, NA, R | P0       |
| Encrypted provider credentials (AES-256-GCM, envelope encryption)             | A, O              | P0       |
| Vault / KMS integration (HashiCorp, AWS KMS)                                  | B(ent)            | P2       |
| **Org → Team → Project → Key → User** hierarchy                               | A, L, B           | P0       |
| Custom roles and RBAC                                                         | A, P, NA          | P1       |
| SSO: OIDC, SAML, GitHub, Google                                               | A, L, B           | P1       |
| SCIM provisioning and directory synchronization                               | A, B              | P2       |
| MFA: TOTP, WebAuthn, passkeys                                                 | A, NA             | P1       |
| Login-session management                                                      | NA                | P1       |
| Change requests for sensitive operations, such as four-eyes approval          | A                 | P2       |
| Complete audit log                                                            | A, L, P           | P1       |
| Model access groups                                                           | L                 | P1       |
| End-user OAuth login (GitHub, Google, Telegram, Discord, OIDC)                | NA                | P1       |
| IP and geography access restrictions                                          | P(ent)            | P2       |
| End-user IDs for tracking                                                     | L, B              | P1       |

### 3.8 Budgets, quotas, and rate limits

| Feature                                                                    | Sources    | Priority |
| -------------------------------------------------------------------------- | ---------- | -------- |
| RPM, TPM, concurrent-request, and image-count limits                       | A, L, H, R | P0       |
| Dollar or token budgets at org, team, project, key, user, and model levels | A, L, B, H | P0       |
| Daily, weekly, and monthly budgets with automatic reset                    | L          | P0       |
| Cost forecasting and predicted budget-exhaustion date                      | A          | P1       |
| A **ledger** behind every cost figure                                      | A          | P0       |
| Subscription quota tracking and reset countdown                            | N, O       | P1       |
| Fair share between team members who use one subscription                   | O          | P2       |
| Free-quota pool accounting without double counting                         | O          | P2       |
| Budget-threshold alerts at 50%, 80%, and 100%                              | L          | P1       |

### 3.9 Billing and monetization

This full capability set was not found in Antirion or OmniRoute. The main source was new-api, described as an "API sales panel". Items marked with † come from documentation or earlier versions and must be re-checked before implementation.

| Feature                                                                        | Sources                     | Priority |
| ------------------------------------------------------------------------------ | --------------------------- | -------- |
| User wallet / prepaid credit                                                   | NA, OR                      | P1       |
| Online top-ups via Stripe and †Epay; Iranian options: Zarinpal, IDPay, NextPay | NA†                         | P1       |
| Gift and top-up redemption codes                                               | NA†                         | P1       |
| Referral / affiliate rewards                                                   | NA†                         | P2       |
| Subscription plans                                                             | NA, G(ent)                  | P2       |
| Model, output, user-group, and cache pricing multipliers                       | NA                          | P1       |
| Per-request pricing for images and video                                       | NA                          | P1       |
| Expression-based tiered usage pricing                                          | NA                          | P2       |
| Public model marketplace with prices                                           | NA, OR                      | P1       |
| Bring your own key (BYOK)                                                      | OR                          | P1       |
| Invoices, monthly statements, CSV/PDF export                                   | No complete example found   | P2       |
| Profit reporting: upstream purchase cost versus sales revenue                  | Differentiation opportunity | P2       |

### 3.10 Guardrails and content security

| Feature                                                             | Sources    | Priority |
| ------------------------------------------------------------------- | ---------- | -------- |
| PII and secret detection, including API keys and tokens             | A, O, L, P | P1       |
| Regex and word lists                                                | A, P       | P1       |
| Output JSON Schema validation                                       | A, P       | P1       |
| Prompt-injection detection                                          | O          | P1       |
| Provider-agnostic moderation                                        | A, O       | P1       |
| LLM-as-judge                                                        | A, T       | P2       |
| Tool-permission checks                                              | A          | P2       |
| Apply checks to requests, responses, and **streams**                | A          | P1       |
| Actions: block, format-preserving redact, flag, divert              | A          | P1       |
| Third-party guardrail plugins; the research recorded 40+ in Portkey | P          | P2       |
| Content logging off by default; when enabled, mask or hash PII      | A          | P0       |

### 3.11 Agents, MCP, and A2A

| Feature                                                                                                          | Sources    | Priority |
| ---------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| **MCP Gateway:** register MCP servers and apply keys, budgets, and logs to them                                  | A, L, B, P | P1       |
| The gateway's own administrative MCP server over stdio, HTTP, and SSE; the research recorded 110 OmniRoute tools | O          | P2       |
| Forward user identity to MCP servers                                                                             | P          | P2       |
| MCP Code Mode                                                                                                    | B          | P2       |
| **A2A:** Agent Card at `/.well-known` and JSON-RPC (`message/send`, `tasks/get`)                                 | A, O, L    | P2       |
| Agent profiles (Claude Code, Codex, OpenCode, etc.) with model overrides and one-click configuration             | R, N, O    | P1       |
| Setup guides for Claude Code, Codex, Cursor, Cline, Roo, Kilo, Continue, Aider, Goose, Windsurf, etc.            | O, N       | P0       |
| VS Code extension to add models to the picker                                                                    | O          | P2       |
| Conversation memory (FTS/vector), with retention controls                                                        | O          | P2       |
| Agent relay through Telegram, Slack, Discord                                                                     | R          | P2       |

### 3.12 Observability and analytics

| Feature                                                                                                                                     | Sources    | Priority |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Per-request logs: selected route, **every attempt and its failure reason**, tokens, cost, cache status, guardrail result, latency, and TTFT | A, R, L    | P0       |
| Agent and tool-call tracing                                                                                                                 | R          | P1       |
| Prometheus metrics                                                                                                                          | A, B, T, L | P0       |
| OpenTelemetry traces, metrics, and logs                                                                                                     | A, H, T, L | P1       |
| External log sinks: Langfuse, Datadog, S3, Kafka                                                                                            | A, L       | P2       |
| Separate log database (ClickHouse)                                                                                                          | NA         | P1       |
| Replay previous requests with a different model or prompt                                                                                   | T          | P2       |
| Build datasets from real traffic, with evaluation and feedback                                                                              | T          | P2       |
| Alerts through Slack, Telegram, email, webhooks                                                                                             | L, NA†     | P1       |

### 3.13 Configuration and operations

| Feature                                                               | Sources  | Priority                                         |
| --------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| Declarative YAML configuration, edited through files, API, or console | A, H     | P1                                               |
| Schema validation, **diffs, versioning, and rollback**                | A        | P1                                               |
| Hot reload without restart                                            | C, A     | P0                                               |
| GitOps                                                                | T        | P2                                               |
| Initial setup wizard                                                  | NA       | P0                                               |
| Global, provider, or connection-level outbound SOCKS5/HTTP proxy      | O, N     | P0; especially important for Iranian deployments |
| Proxy pool, IP rotation, relay                                        | N, O     | P1                                               |
| Remote access tunnel (Cloudflare Tunnel)                              | N        | P2                                               |
| IPv4/IPv6 egress controls                                             | O        | P2                                               |
| Internationalization, including **Persian and RTL**                   | NA       | P0                                               |
| Model playground                                                      | NA, T, G | P1                                               |
| Middleware / plugin system                                            | B, NA, R | P2                                               |
| Complete management API covering all UI operations                    | C, A     | P0                                               |
| Embeddable SDK                                                        | C        | P2                                               |

### 3.14 Deployment and supply chain

| Feature                                                     | Sources  | Priority |
| ----------------------------------------------------------- | -------- | -------- |
| Distroless / non-root Docker images for amd64 and arm64     | A, O, NA | P0       |
| Docker Compose for single-node and clustered deployments    | A, C     | P0       |
| Helm chart with HPA autoscaling                             | A, L     | P1       |
| Lightweight personal single-node mode with embedded storage | A, O     | P2       |
| npm, Electron/Tauri desktop application, PWA                | O, N, R  | P2       |
| SBOM, Sigstore signatures, SLSA provenance                  | A        | P2       |
| Published benchmark harness                                 | A, H     | P1       |

---

## 4. Feature comparison matrix

Legend: ✅ supported, ⚠️ partial or only in the paid edition, ❌ absent or not reported.

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

Core principle: **the data plane must not depend on the control plane.** If PostgreSQL, NestJS, or the dashboard goes down, live traffic must keep flowing.

1. **Separate data and control planes.** The gateway receives its configuration from the control plane, keeps a versioned snapshot in memory and on disk, and receives updates through Valkey pub/sub or long polling. During a control-plane outage it keeps running on the last valid configuration.
2. **Stateless gateways with distributed counters.** Implement rate limits and budgets in Valkey, using sliding windows or GCRA with Lua scripts. **Local fallback:** divide quotas between nodes and use in-memory limiting when Valkey is unavailable. Make fail-open or fail-closed configurable per tenant.
3. **Asynchronous accounting.** Record live consumption in Valkey, enqueue events (the research proposed NATS JetStream or Redis Streams), then persist a PostgreSQL ledger and ClickHouse logs. The request path never waits for database writes. An **idempotency key** prevents double-charging; a local on-disk outbox covers queue outages. The accepted MVP later chose BullMQ and PostgreSQL logs instead.
4. **Three fault-isolation layers, following the OmniRoute pattern:** provider circuit breakers, per-credential cooldowns, and per-model lockouts, with half-open probes and adaptive backoff.
5. **Hedging and timeouts:** separate timeouts for connect, TTFT, and stream idle time. If TTFT exceeds p95, consider sending a hedge to a second provider, only for idempotent requests or with an explicit hedge budget.
6. **Stream-safe failover:** allow full fallback before any bytes are sent to the client. After partial output has been sent, return a standard error. Continuing a stream on another provider is experimental P2 work.
7. **Bulkheads:** separate connection pools and concurrency limits per provider and per tenant, so one slow provider or one heavy customer cannot exhaust the system.
8. **Infrastructure proposal:** PostgreSQL with Patroni or CloudNativePG (primary/replica) and PgBouncer; Valkey Sentinel or Cluster; single-node ClickHouse at first; gateway replicas behind a load balancer, with PodDisruptionBudgets, readiness and liveness probes, and graceful SSE draining.
9. **Chaos and load tests:** k6 or vegeta with a mock provider that generates 429s, 5xx errors, and random latency, run in CI. Proposed SLOs: p99 overhead below 5 ms and 99.95% availability.

---

## 6. Practical dashboard — proposed pages

Combine Antirion's Overview and per-attempt logs, OmniRoute's Health and Costs tabs, new-api's model marketplace and playground, and CCR's request diagnostics.

| Page                            | Contents                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                    | Cost, requests, tokens, p50/p95/p99 latency, TTFT, error and cache-hit rates, savings from cache, compression, and free routes, top models and teams, **provider headroom**                       |
| **Live / Realtime**             | Live request stream (WebSocket), current RPS, in-flight requests, provider status map                                                                                                             |
| **Health**                      | Provider circuit-breaker states, keys in cooldown, locked models and their unlock times, incident history, provider uptime                                                                        |
| **Requests (Log Explorer)**     | Filters by key, team, model, status, cost, latency; request details with attempt timelines, failure reasons, guardrail results, cache status, optional body logging, and replay in the playground |
| **Costs & Budgets**             | Cost by org, team, project, key, user, and model; forecasts and exhaustion dates; ledger; subscription / free / paid split; CSV export                                                            |
| **Quotas**                      | Account and subscription quotas, reset countdown, utilization                                                                                                                                     |
| **Providers & Credentials**     | Add-provider wizard, connection tests, model discovery, multiple credentials, per-connection proxy settings                                                                                       |
| **Models / Catalog**            | Prices, context windows, capabilities, aliases and mappings, public model marketplace                                                                                                             |
| **Routing / Combos**            | Drag-and-drop fallback and strategy editor, **routing simulator**, per-rule traffic share                                                                                                         |
| **Keys & Access**               | Virtual keys, allowed models, limits, expiry, IP allowlists, rotation                                                                                                                             |
| **Org / Teams / Users / Roles** | Hierarchy, RBAC, SSO/SCIM, invitations                                                                                                                                                            |
| **Billing**                     | Wallet, top-ups, gift codes, plans, invoices, group prices, profit reporting                                                                                                                      |
| **Guardrails**                  | Policies, live tests, block and redaction statistics                                                                                                                                              |
| **Cache & Compression**         | Hit rates, savings, cache purge, Compression Studio                                                                                                                                               |
| **MCP & Agents**                | MCP server registration, tool access and logs, agent profiles with ready-to-use Claude Code and Codex snippets                                                                                    |
| **Playground**                  | Side-by-side model comparison with cost and latency                                                                                                                                               |
| **Config**                      | Validated YAML editing, diffs, history, rollback, change requests                                                                                                                                 |
| **Alerts**                      | Budget, error, and outage rules, with Telegram, Slack, email, and webhook channels                                                                                                                |
| **Audit Log**                   | Every configuration change, with its diff                                                                                                                                                         |

UX proposals:

- Full RTL/LTR support, Solar Hijri and Gregorian calendars, light and dark themes.
- A global time range, drill-down from charts to logs, shareable links for filters.
- Command palette (`Cmd+K`).

---

## 7. Original technology proposal

### 7.1 Evaluation of NestJS + React + PostgreSQL

| Layer                                                          | Original user choice | Research assessment                                                                                                                                                                                                                         | Original proposal                                                                                                                           |
| -------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane:** admin API, auth, billing, config, reporting | NestJS               | Excellent fit: modules, DI, guards/RBAC, OpenAPI, and a good ecosystem                                                                                                                                                                      | **NestJS with Fastify adapter**                                                                                                             |
| **Data plane:** the LLM request hot path                       | NestJS               | The research judged per-request DI, interceptors and pipes, plus Node's GC and single-threaded execution, a tail-latency and memory risk at tens of thousands of concurrent streams. It compared Rust/Go gateways with local Node projects. | **Go**, with Rust as an alternative; later superseded by ADR-001                                                                            |
| **Frontend**                                                   | React                | Suitable                                                                                                                                                                                                                                    | React + Vite + TypeScript, TanStack Router/Query, shadcn/ui (Radix) + Tailwind with RTL, ECharts or Recharts, TanStack Table, react-i18next |
| **Primary database**                                           | PostgreSQL           | Excellent fit for users, keys, config, and the ledger                                                                                                                                                                                       | **PostgreSQL 17** + PgBouncer                                                                                                               |
| **Logs and analytics**                                         | PostgreSQL           | The research anticipated difficulties with millions of raw log rows per day and fast dashboard aggregates                                                                                                                                   | **ClickHouse**, as new-api uses it; TimescaleDB was another initial option for low volume                                                   |
| **Counters, cache, pub/sub**                                   | Not specified        | Needed                                                                                                                                                                                                                                      | **Valkey**, an open Redis fork                                                                                                              |
| **Event queue**                                                | Not specified        | Needed                                                                                                                                                                                                                                      | **NATS JetStream**, or Redis Streams at first                                                                                               |
| **Vectors for semantic cache and memory**                      | Not specified        | Needed                                                                                                                                                                                                                                      | **pgvector** on PostgreSQL; Qdrant at larger scale                                                                                          |

### 7.2 Why Go for the data plane?

The reasoning in the research was:

- Overhead under 1 ms and stable tail latency, citing Bifrost as a Go example.
- Goroutines suit many concurrent SSE streams, and `net/http` and `httputil` are mature.
- CLIProxyAPI and new-api are Go examples from which translators and executors can be learned.
- Go is easier for a TypeScript team to learn than Rust. Rust was mainly suggested for a direct performance challenge against Antirion.
- **If the team knows only TypeScript,** the alternative was to write the data plane as a separate service on plain Node + Fastify or uWebSockets (without Nest), with a stable interface that could later be swapped for Go. The research still preferred Go for the high-scale goal.

These were design proposals, not measured DiRouter results. ADR-001 later chose NestJS on Fastify, with strict hot-path rules and a benchmark-based rewrite option.

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
- NestJS ORM: **Drizzle** or **Prisma**. The team's existing Prisma experience supports keeping it. Run migrations from a single source of truth.
- Go/TS contracts: JSON configuration snapshots with a shared schema. Internal communication can use gRPC or HTTP, plus Valkey pub/sub.

The actual TypeScript-first repository layout is documented in the [project README](../../../code/README.md).

---

## 8. Original proposed roadmap

| Phase        | Scope                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP (P0)** | OpenAI and Anthropic APIs and translation; about 15 main providers plus OpenAI-compatible servers; combos and multi-level fallback; circuit breakers, cooldowns, lockouts, retries, and timeouts; virtual keys; org/team/project; rate limits and budgets; ledger; request logs; outbound proxy; Overview, Health, Requests, Providers, Keys, and Combos pages; Persian/RTL; Docker Compose |
| **v1 (P1)**  | Full Gemini and Responses APIs; latency, cost, headroom, and classifier routing; hedging; exact and semantic caching; RTK/dedup compression; SSO, MFA, RBAC, and audit; guardrails; MCP gateway; billing (wallet, payments, gift codes, pricing multipliers); ClickHouse; OTel and Prometheus; Helm; config diffs and rollback; playground; alerts                                          |
| **v2 (P2)**  | Full image, audio, video, and search support; A2A; memory; SCIM; plugins; A/B tests and evaluations; VS Code extension; desktop app; optional OAuth-subscription plugins with terms-of-service notices; SBOM and signing                                                                                                                                                                    |

---

## 9. Decisions requested from the research

1. **Business model:** enterprise self-hosting only, like Antirion, or an API sales panel as well, like new-api or OpenRouter? This choice sets the weight of billing work.
2. **OAuth subscriptions and web cookies:** exclude them, offer them as optional plugins, or include them in the core, given the service terms?
3. **Data-plane language:** Go (recommended), Rust, or plain Node?
4. **Payment gateways:** Iranian, international, or both?

---

## Sources recorded by the research

- https://antirion.ai/
- https://www.omniroute.online/ — https://github.com/cheaper-inference/OmniRoute
- https://9router.com/ — https://github.com/decolua/9router
- https://docs.litellm.ai/docs/simple_proxy
- https://github.com/maximhq/bifrost
- https://github.com/Portkey-AI/gateway
- https://github.com/QuantumNous/new-api — https://docs.newapi.ai/
- https://github.com/router-for-me/CLIProxyAPI
- https://github.com/musistudio/claude-code-router
- https://github.com/tensorzero/tensorzero
- https://github.com/Helicone/ai-gateway
- https://github.com/theopenco/llmgateway
- https://www.getmaxim.ai/articles/top-5-portkey-alternatives-in-2026/
- https://llmgateway.io/blog/litellm-alternatives
- https://coworker.ai/blog/litellm-alternatives
