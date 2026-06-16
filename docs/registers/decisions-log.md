# Decisions Log

The chronological index of every decision that shaped BadaBhai. Heavyweight /
architectural decisions get a full **ADR** in [`docs/decisions/`](../decisions/);
lightweight calls live in [team-decisions.md](./team-decisions.md). This file
indexes both so there is one timeline.

| Date | Decision | Type | Where |
| ---- | -------- | ---- | ----- |
| 2026-06-08 | MVP infra & AI: Supabase Postgres, API-first AI via LiteLLM, no self-hosted LLM, mandatory fail-closed pseudonymization, Flutter, worker-profiling-first | ADR | [0001-mvp-infra-decision.md](../decisions/0001-mvp-infra-decision.md) |
| 2026-06-09 | Revenue model = **employer/agency pays to unlock candidates**; workers free | Team | [team-decisions.md](./team-decisions.md) |
| 2026-06-09 | Team size assumption = **2–5**; quality gates calibrated to automation + one human reviewer | Team | [team-decisions.md](./team-decisions.md) |
| 2026-06-09 | Immediate priority = **close Phase-1 "next" items** (BullMQ jobs, real OTP, RLS, STT, real LLM in staging) | Team | [team-decisions.md](./team-decisions.md) |
| 2026-06-09 | Adopted the **engineering-org layer** (agents, skills, workflow, gates, registers) | Team | [team-decisions.md](./team-decisions.md) |
| 2026-06-09 | **Async profile extraction (BullMQ)** + **generic events-only action recorder** (`action.recorded`); `/profile/extract` → `202` + poll | ADR | [0002-async-extraction-and-action-recording.md](../decisions/0002-async-extraction-and-action-recording.md) |
| 2026-06-12 | **Reach foundation — deterministic RANK core + behavioural event contracts** ratified (Proposed→Accepted). Implemented weights are authoritative; the locked "Skills 15" + Vertex skills-similarity is deferred to Phase 2/LEARN | ADR | [0006-reach-foundation-rank-core.md](../decisions/0006-reach-foundation-rank-core.md) |
| 2026-06-15 | **LiteLLM → direct Gemini/Claude provider calls** — ratifies the shipped direct-provider stack (Gemini primary + Claude Haiku fallback behind the `LlmAdapter`/`AIRouter` seam); supersedes ADR-0001 §3. Closes TD28 (env unify on `GEMINI_FLASH_API_KEY`); names the TD27 spend-cap hook | ADR | [0008-litellm-to-direct-providers.md](../decisions/0008-litellm-to-direct-providers.md) |
| 2026-06-15 | **Ops-created, vacancy-banded, stored-only Job Postings** (alpha-gate) — additive `job_posting` event domain + `job_postings` table; banded vacancy enum (`1`/`2-5`/`6-10`/`11-25`/`25+`); opaque ops `created_by`; NON-PII free text stored-only (never in events); `draft→open→closed` lifecycle (closed terminal). Coexists with — does not supersede — PR #42 `jobs`/`job.*`. Amended per the principal-engineer review (D1/D2/D3) | ADR | [0010-ops-job-postings-banded-stored-only.md](../decisions/0010-ops-job-postings-banded-stored-only.md) |

## How to add a decision

1. Decide whether it's **ADR-worthy** (architectural, hard to reverse, cross-cutting)
   or **lightweight** (priority, scope, vendor lean, process).
2. ADR → copy the format of [ADR-0001](../decisions/0001-mvp-infra-decision.md),
   number it sequentially (`000N-<slug>.md`), set Status.
3. Lightweight → add a dated row to [team-decisions.md](./team-decisions.md).
4. Either way, **add a row here** so the timeline stays complete.

## ADR index

- [0001 — MVP Infrastructure & AI Decisions](../decisions/0001-mvp-infra-decision.md) — *Accepted*
- [0002 — Async Profile Extraction (BullMQ) + Generic Action Recording](../decisions/0002-async-extraction-and-action-recording.md) — *Accepted*
- [0006 — Reach foundation: deterministic RANK core + behavioural event contracts](../decisions/0006-reach-foundation-rank-core.md) — *Accepted (ratified 2026-06-12)*
- [0008 — LiteLLM → direct Gemini/Claude provider calls](../decisions/0008-litellm-to-direct-providers.md) — *Accepted (supersedes ADR-0001 §3)*
- [0010 — Ops-created, vacancy-banded, stored-only Job Postings](../decisions/0010-ops-job-postings-banded-stored-only.md) — *Accepted (alpha-gate, 2026-06-15)*
