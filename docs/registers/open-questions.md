# Open Questions

Unknowns that block or shape decisions. When answered, move the row to
**Resolved** with the answer + where it was recorded (ADR / team-decision).

Seeded 2026-06-09.

| ID | Question | Why it matters | Status |
| -- | -------- | -------------- | ------ |
| Q1 | Which **real OTP provider** (MSG91 / Gupshup / Twilio / Firebase)? Cost, deliverability in tier-2/3 India, latency? | Blocks TD2 and real onboarding | Open |
| Q2 | **Unlock pricing model** — per-unlock credits vs employer subscription tiers vs hybrid? Price points? | Drives Phase-2 payments design + PRD + cost model | Open |
| Q3 | Default **LLM provider/model** for extraction & canonicalization? Cost/latency/quality trade-off? | Drives R6 cost projection and staging enablement | **Resolved (2026-06-15, [ADR-0008](../decisions/0008-litellm-to-direct-providers.md))** — direct providers: Gemini (primary, capable=`gemini-2.5-flash`, cheap=`gemini-2.5-flash-lite`) → Claude Haiku 4.5 fallback → mock. **Cost/quality CONFIRMED in staging (2026-06-15, Claude Haiku primary, behind the TD27 cap): 95% per-field accuracy (151/159), 56/56 real calls clean (0% error), ₹0.267/call (≈₹0.27–0.5/worker), 0 over-masking.** The written, numeric **prod-flip threshold** is in [ADR-0008](../decisions/0008-litellm-to-direct-providers.md). Remaining before a prod flip (not blocking this resolution): latency not yet measured + ≥2 more staging runs + shared-store ledger + secrets manager |
| Q4 | **Sarvam STT** contract, pricing, latency, language coverage (Hindi + regional)? | Blocks TD6 voice profiling | Open |
| Q5 | Concrete **RLS model** — how do we map worker auth identity → `workers` row for per-worker isolation? | Blocks R1/TD4 | Open |
| Q6 | **DPDP data-residency** requirement — must all PII stay in an India region? Affects Supabase region + any provider | Launch gate; affects infra | Open |
| Q7 | **Scale targets** — workers onboarded and employers active at 6 / 12 months? | Needed for cost projection + capacity planning | Open |
| Q8 | **Embeddings/model-training tables** were frozen into the schema — what is the intended first use (semantic search? matching?) and when? | Shapes Phase-2 AI roadmap | Open |
| Q9 | **Reusable consent gate** ([ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) OQ-1) — the API had no shared "require active consent before this action" primitive; chat/profiling enforced the DPDP gate at their own boundaries. The alpha apply/skip routes need it too | Net-new shared surface; the alpha swipe-to-apply routes must sit behind the consent gate (invariant 6) | **Resolved (2026-06-15, [ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md))** — a reusable `ConsentGuard` (`apps/api/src/auth/consent.guard.ts`) was built and applied to all three worker routes (feed/apply/skip); passed two security reviews |
| Q10 | **`trade_key` taxonomy linkage** ([ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) OQ-2) — `@badabhai/db` cannot import the 15-key alpha-trade list from `apps/api` or `@badabhai/event-schema` (dependency direction), so `jobs.trade_key` mirrors `TradeKey` (+ `SkipReason`/`SourceSurface`) as local unions with "keep in sync" comments. Source of truth = `REQUIRED_TRADE_KEYS` in `apps/api` | Two copies of the enum can drift; feed/profile trades must align | Open — follow-up: extract a shared `taxonomy/enums` package so `@badabhai/db` and `apps/api` consume one source (tracked as tech-debt, [TD31](./tech-debt-register.md)) |
| Q11 | **RLS for `jobs` + `applications`** ([ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) OQ-3) — both new tables are accessed via the backend service role today (ADR-0004), like the rest of Phase-1; `applications.worker_id` references `workers` | Must be covered when RLS is finalised so the new tables join the locked spine (TD20) | Open — add `jobs` + `applications` to the [rls-plan](../../infra/supabase/rls-plan.md) when RLS lands (cross-link [TD4/TD20](./tech-debt-register.md), [R1/R15](./risks-register.md)) |

> Keep this list short and live. A question that's been "Open" for months either
> needs an owner and a decision, or it isn't really blocking — say which.
