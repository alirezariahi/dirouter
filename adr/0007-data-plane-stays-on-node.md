# ADR-0007: The data plane stays on Node for v1, scaled out per replica

- **Status:** Accepted
- **Date:** 2026-11-23
- **Decision makers:** DiRouter team

## Context

ADR-0001 chose NestJS on Fastify for the gateway, with a target of **hot-path p99 overhead below
5 ms**. It also said the gateway would move to Go if benchmarks missed that target. The v1
benchmark ([docs/benchmarks/v1.md](../docs/benchmarks/v1.md)) measured one gateway process
against the mock provider directly:

| Load per process | p50 overhead | p95 overhead | p99 overhead |
| ---------------- | ------------ | ------------ | ------------ |
| 250/s            | +1.1 ms      | +2.3 ms      | +2.8 ms      |
| 500/s            | +0.6 ms      | +2.0 ms      | +7.2 ms      |
| 1 000/s          | +0.2 ms      | +3.1 ms      | +31.3 ms     |

Profiling found one real hotspot in DiRouter code (the per-model request window, 13.5% of CPU),
which was fixed (−12.4% CPU). What remains is socket I/O, the HTTP client and garbage collection.

### Decision drivers

- Meet the p99 target at the load each replica actually carries.
- Keep one language across contracts, translators and pricing (the reason for ADR-0001).
- Do not start a rewrite of the component with the most behaviour (routing, fallback, limits,
  wallets, media, MCP, plugins) without evidence that scaling out cannot meet the target.

### Considered options

1. **Rewrite the data plane in Go now.**
2. **Keep Node, scale out:** run replicas below the load where p99 stays within target, and keep
   measuring.
3. **Keep Node, use worker threads** inside one process.

## Decision

Option 2. The overhead is small at p50 and p95 at every tested load, and the p99 target holds at
250/s per process. The tail growth is the shape of one event loop near saturation, which more
replicas fix at a known cost. A Go rewrite would duplicate the shared TypeScript packages for a
gain the current data does not require. Worker threads (option 3) would add cross-thread
serialization to every request for the same effect as more processes.

Operating rule for v1: size the gateway at **at most 250 non-stream requests per second per
replica** on hardware of this class (or the measured equivalent on the production hardware), and
autoscale on the gateway's event-loop lag (`dirouter_gateway_nodejs_eventloop_lag_seconds`) and request rate.

## Consequences

### Positive

- No rewrite; every feature keeps a single implementation.
- The capacity rule is explicit and checked by a reproducible harness (`scripts/bench/run-v1.py`).

### Negative

- More replicas, and so more memory, than a Go gateway would need for the same traffic.
- The rule is measured on a development machine; it must be re-measured on production hardware.

### Revisit when

Reopen the Go question if any of these holds:

- On production hardware, p99 overhead exceeds 5 ms at the planned load per replica.
- Gateway CPU per non-stream request rises above 1 ms (0.54 ms today).
- The pending LiteLLM comparison shows DiRouter with markedly higher overhead or CPU per request at
  equal load.

### Follow-up

- Run the LiteLLM comparison once its image is available on the benchmark host.
- Repeat the benchmark on dedicated hardware, with the load generator on another machine.
