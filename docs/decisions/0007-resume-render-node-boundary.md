# ADR-0007: Resume PDF render runs in Node, never in the AI service

- **Status:** Accepted (implemented 2026-06-12)
- **Date:** 2026-06-12
- **Supersedes/relates:** advances **TD5** (resume generation, layer 2 — the PDF
  artifact); builds on **TD21** (`full_name` encrypted at rest, injected server-side
  post-AI) and **ADR-0004** (PII at rest + the AI privacy boundary). Adds three event
  contracts to `@badabhai/event-schema` (`resume.downloaded` / `resume.regenerated` /
  `resume.shared`) and five columns to `generated_resumes` (migration `0010`). New
  residual risk **R13**; new debt **TD24**.

## Context

Every profiled worker gets a free, downloadable PDF resume (the "second front door").
Layer 1 already generates the resume **text/JSON** synchronously and injects the worker's
real name server-side *after* the LLM call, so the name never reaches the AI service
(TD21). Layer 2 adds the **PDF**: canonical profile + trade content + skeleton → HTML →
**WeasyPrint** → a private object store, served by signed URL, pre-generated on
`profile.confirmed`.

WeasyPrint is a Python-only library, so the obvious home is the existing Python
`apps/ai-service`. But the rendered PDF must carry the worker's **real name**, and the
AI-service contract (`@badabhai/ai-contracts`, `apps/ai-service/app/contracts.py`) makes a
**service-boundary** guarantee: *"these contracts never carry raw worker identity… the
name never reaches the AI service."* Today the AI service has **zero** code paths that
legitimately hold a real name — every endpoint pseudonymizes first. A render endpoint
there would be the *first* raw-PII channel into that process.

## Decision

**Render the PDF in the Node API, never in `apps/ai-service`.** The worker's name stays on
the Node side of the seam, co-located with the decryption key (`PiiCryptoService`) where
the decrypted phone already lives.

- **Renderer** (`apps/api/src/resume/resume-renderer.service.ts`): builds a print-CSS HTML
  document (every interpolated value **HTML-escaped** — the name is user-controlled) and
  invokes the `weasyprint` CLI as a **local subprocess** (`weasyprint - -`, HTML on stdin,
  PDF on stdout). Gated behind `RESUME_RENDER_ENABLED` (off by default). **Degrades to
  null** — kill-switch off, binary missing (e.g. local Windows dev), timeout, size-guard,
  or non-zero exit all return "no PDF this run" rather than throwing (mirrors
  `ai.service`'s mock fallback). stderr is **swallowed unlogged** (it can echo the
  name/markup); the name is never logged.
- **Async worker**: a BullMQ `resume-render` queue + processor renders off the request
  path, uploads to a **private** Supabase Storage bucket (REST over `fetch`, no SDK), and
  flips `generated_resumes.render_status` → `rendered`. A separate `resume-generate` queue
  pre-generates on `profile.confirmed` (idempotent; one resume per worker on the auto
  path). The render job data is **refs only** (no name); the name is decrypted inside the
  processor with the same degrade-on-failure discipline as layer 1.
- **Download**: `GET /resume/:id/download` mints a short-TTL signed URL
  (`RESUME_SIGNED_URL_TTL_SECONDS`, default 900s) server-side per request and emits
  `resume.downloaded`. Object keys are opaque UUIDs (`resumes/{workerId}/{resumeId}/v{n}.pdf`).
- **Abuse**: a Redis daily rate-cap (per-worker + a global backstop), atomic INCR+EXPIRE,
  **fails closed** on a Redis outage so an outage can't uncork unlimited paid-path spend.
- **Events**: `resume.generated` (v1) / `resume.regenerated` (v>1, with `previous_version`)
  / `resume.downloaded` / `resume.shared` — all PII-free (IDs + closed enums). No event on
  render completion (only the row's `render_status` flips).

## Consequences

- **Good:** the AI service stays categorically PII-free — the TD21/ai-contracts guarantee
  holds because the name never enters that process, not because of a guard inside it. The
  name and the renderer sit on the same side as the decryption key. Render is a kill-switch
  away from prod and degrades cleanly in dev.
- **Cost:** WeasyPrint's native stack (Pango/cairo) must be installed in the **API
  container** (devops follow-up, TD24); not trivially runnable on local Windows (hence the
  degrade-to-null). The PDF is now a downloadable artifact containing a real name → DPDP-
  relevant and exposed via an as-yet-unauthenticated route (R13; gated on TD4).
- **Rejected alternatives:** *(a)* WeasyPrint inside `ai-service` — breaks the documented
  boundary; the security gate flagged it escalate-to-humans. *(b)* a dedicated Python
  render microservice — honors WeasyPrint + the boundary but adds a deployable; reach for
  it only if Node-side print fidelity proves insufficient. *(c)* headless Chromium in Node
  — heavier dependency than the WeasyPrint subprocess, and the user specified WeasyPrint.
