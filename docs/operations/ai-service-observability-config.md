# ai-service: observability and spend-ledger configuration

Two settings that **fail silently or fail closed** when they are wrong, both found during
Phase 7 on a Windows/Docker developer machine and both applicable to any deployment.

Neither value is a secret. Nothing here belongs in git as a value — only as a requirement.

---

## 1. `LANGFUSE_BASE_URL` must match the region the keys were issued in

### The failure

A US key pair against the EU host **does not disable tracing and does not raise**:

- the service logs `langfuse enabled`
- spans are produced, masked, and buffered normally
- the OTLP exporter is then rejected per batch:

```
opentelemetry.exporter.otlp.proto.http.trace_exporter
Failed to export span batch code: 401
```

Every trace is dropped while every health signal says tracing is fine. The log line is on a
third-party logger nobody watches.

### Why it matters

Observed for real in Phase 7: a corpus embed of 98 aliases completed successfully, was
metered correctly (`estimated_cost_inr` recorded), and left **no trace at all**. It was
caught only because a gate checklist required reading the trace back *out* of Langfuse
rather than trusting the service log. A run that "succeeded" and produced no observability
is indistinguishable from a healthy one from the inside.

### The setting

```bash
# .env for apps/ai-service — pick the host matching your key pair
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com   # US keys
# LANGFUSE_BASE_URL=https://cloud.langfuse.com    # EU keys (the config.py default)
```

`apps/ai-service/app/config.py` defaults to the **EU** host. The ai-service loads
`apps/ai-service/.env`; a value set only in the repo-root `.env` does **not** reach it.

### How to verify (no secret printed)

```bash
cd apps/ai-service
python -c "from app.config import get_settings; print(get_settings().langfuse_base_url)"
```

Then make one traced call and read it back through the public API. Confirm the trace carries
`feature:taxonomy`, `real-call`, `task:skill_embedding`, a model, `usageDetails`, and
`estimated_cost_inr`, and that the service log contains **zero** `Failed to export span
batch` lines. A green service log alone is not evidence.

---

## 2. `AI_SPEND_REDIS_URL` must resolve to an address the client can actually reach

### The failure

The SpendLedger is Redis-backed and **fails closed**: when the store is unreachable,
`would_exceed_spend` returns `spend_store_unavailable` and every real AI call is blocked. It
surfaces to a caller as `budget_stopped: true` with `errors: 0` — which reads like an
exhausted budget, not an infrastructure fault.

That behaviour is correct (an unverifiable cap must never permit a real spend). The trap is
diagnosing it.

### Root cause seen in Phase 7

```
AI_SPEND_REDIS_URL hostname   = localhost
getaddrinfo("localhost")      = [AF_INET6, AF_INET]     ← ::1 first on this host
docker compose publishes redis  127.0.0.1:6379          ← IPv4 only, deliberate loopback bind

redis://127.0.0.1:6379  →  PING OK in 3 ms
redis://[::1]:6379      →  TimeoutError after 2012 ms   ← what the service was doing
```

`redis.asyncio` tried the IPv6 address first and timed out against the 2-second client
budget. `redis-cli ping` inside the container worked the whole time, and a raw TCP connect
from Node succeeded — only the Python client's resolution order exposed it.

### The setting

```bash
# .env for apps/ai-service — prefer an IP literal over `localhost` on any host whose
# resolver returns ::1 first, since compose publishes IPv4 only.
AI_SPEND_REDIS_URL=redis://127.0.0.1:6379
```

The `redis` service is declared in `docker-compose.yml` but is **not** started by
`docker compose up -d postgres`. Start it explicitly:

```bash
docker compose up -d redis
docker exec badabhai-redis redis-cli ping      # PONG
```

### How to distinguish this from a real budget stop

```
budget_stopped: true, errors: 0, results: []
```

Check the service log for the reason. `spend_store_unavailable` is infrastructure;
`daily_cap_exceeded` / `cumulative_cap_exceeded` / `user_daily_cap_exceeded` are real caps.

Do **not** work around `spend_store_unavailable` by unsetting `AI_SPEND_REDIS_URL`. That
falls back to the in-process backend and turns a global cap into a per-process one — it
converts a fail-closed guard into a weaker guard that appears to work.

---

## Checklist before any gated real-call run

- [ ] `docker compose up -d redis`, `redis-cli ping` → `PONG`
- [ ] `AI_SPEND_REDIS_URL` resolves to a reachable address (IP literal on IPv6-first hosts)
- [ ] `LANGFUSE_BASE_URL` matches the key region
- [ ] probe one real call: `is_mock=false`, expected dimensions, `budget_stopped=false`
- [ ] read the resulting trace back **out of Langfuse**, and confirm zero OTLP 401s
