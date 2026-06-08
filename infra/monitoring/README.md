# Monitoring & Observability

Phase 1 keeps observability lightweight and placeholder-driven:

- **Structured logging** — each service logs JSON with a `request_id` /
  `correlation_id` for tracing a request across API → AI service.
- **Langfuse (placeholder)** — `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` env
  vars are reserved for LLM tracing. No live integration in Phase 1.
- **Events table** — the `events` table is itself an audit/observability surface;
  the ops console exposes a read-only event stream.

TODO (later): metrics (Prometheus/OpenTelemetry), dashboards, alerting, and a
real Langfuse integration once `AI_ENABLE_REAL_CALLS` is turned on in staging.
