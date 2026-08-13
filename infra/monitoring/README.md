# Monitoring & Observability

Phase 1 keeps observability lightweight and placeholder-driven:

- **Structured logging** — each service logs JSON with a `request_id` /
  `correlation_id` for tracing a request across API → AI service.
- **Langfuse (wired, dormant)** — `apps/ai-service/app/ai/langfuse_tracing.py` is a
  real, key-gated tracing integration, called from the router, embeddings, and every
  `routers/*.py` LLM-touching endpoint. It initializes only when both
  `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set (`settings.langfuse_enabled`)
  and no-ops otherwise — so it is dormant because no keys are configured in any
  committed environment, not because the integration is unbuilt. `GET /health`
  reports `langfuse_enabled` live.
- **Events table** — the `events` table is itself an audit/observability surface;
  the ops console exposes a read-only event stream.

TODO (later): metrics (Prometheus/OpenTelemetry), dashboards, alerting. Langfuse
activates the moment `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are provisioned —
no code change is required.
