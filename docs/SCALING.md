# Hosted Gateway — Horizontal Scaling Plan

## Current state

`@sunday/hosted-gateway` is a single Node.js process serving an OpenAI-compatible
text-chat API. It holds per-key rate-limit state in memory (token buckets).

## Scaling plan (when needed)

1. **Stateless processes**: Extract all per-key state (rate limits, usage counters)
   into Redis. Each gateway instance becomes stateless and interchangeable.

2. **Load balancer**: Run N instances behind a round-robin LB (e.g. Caddy, nginx).
   No sticky sessions needed once state is in Redis.

3. **Shared config**: Model allowlist, rate-limit parameters, and IP allowlists
   move to a shared config store (env + Redis pub/sub for live reload).

4. **Audit log**: JSONL audit lines ship to a central collector (e.g. Loki,
   or append to object storage) instead of local disk.

5. **Health checks**: `/health` already exists — the LB uses it for readiness.

## What NOT to scale

`sundayd` is per-user by design (ADR-001) and never needs horizontal scaling —
one process per user is the architecture, not a bottleneck.

## Load-test targets (to be measured)

| Metric | Target |
|---|---|
| Throughput | ≥ 50 req/s per instance |
| p50 latency | < 200ms (cache hit) |
| p99 latency | < 2s (upstream-bound) |

Run with `k6` or `autocannon` against `/v1/chat/completions` with a mocked
upstream before claiming these numbers.
