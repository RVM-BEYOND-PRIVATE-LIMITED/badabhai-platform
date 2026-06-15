# Open Questions

Unknowns that block or shape decisions. When answered, move the row to
**Resolved** with the answer + where it was recorded (ADR / team-decision).

Seeded 2026-06-09.

| ID | Question | Why it matters | Status |
| -- | -------- | -------------- | ------ |
| Q1 | Which **real OTP provider** (MSG91 / Gupshup / Twilio / Firebase)? Cost, deliverability in tier-2/3 India, latency? | Blocks TD2 and real onboarding | Open |
| Q2 | **Unlock pricing model** — per-unlock credits vs employer subscription tiers vs hybrid? Price points? | Drives Phase-2 payments design + PRD + cost model | Open |
| Q3 | Default **LLM provider/model** for extraction & canonicalization? Cost/latency/quality trade-off? | Drives R6 cost projection and staging enablement | **Resolved (2026-06-15, [ADR-0008](../decisions/0008-litellm-to-direct-providers.md))** — direct providers: Gemini (primary, capable=`gemini-2.5-flash`, cheap=`gemini-2.5-flash-lite`) → Claude Haiku 4.5 fallback → mock. Final cost/quality still to be confirmed by the staging ≥90% eval |
| Q4 | **Sarvam STT** contract, pricing, latency, language coverage (Hindi + regional)? | Blocks TD6 voice profiling | Open |
| Q5 | Concrete **RLS model** — how do we map worker auth identity → `workers` row for per-worker isolation? | Blocks R1/TD4 | Open |
| Q6 | **DPDP data-residency** requirement — must all PII stay in an India region? Affects Supabase region + any provider | Launch gate; affects infra | Open |
| Q7 | **Scale targets** — workers onboarded and employers active at 6 / 12 months? | Needed for cost projection + capacity planning | Open |
| Q8 | **Embeddings/model-training tables** were frozen into the schema — what is the intended first use (semantic search? matching?) and when? | Shapes Phase-2 AI roadmap | Open |

> Keep this list short and live. A question that's been "Open" for months either
> needs an owner and a decision, or it isn't really blocking — say which.
