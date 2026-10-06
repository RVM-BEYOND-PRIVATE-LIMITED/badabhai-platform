# ADR-0046: Bada Bhai companion v2 — an LLM task router on the chat tab

- **Status:** **Accepted — signed by the owner (CEO / Prakash) on 2026-10-05.** Owner rulings O1–O17
  were taken on 2026-09-28 in the design session. Build may start behind flags that default off.
  **Turning any v2 flag on in production required the owner's signature at the foot, and required
  companion v1 (ADR-0044) to be live first — both are now satisfied** (ADR-0044 signed the same
  day; companion v1 has been live since 2026-09-27). The v2 flags being ON and the model tasks armed
  on the box is a separate production action, recorded in the spec README.
- **Date:** 2026-09-28
- **Owner:** CEO / Prakash
- **Amends:** [ADR-0044](0044-post-completion-chat-companion.md) **R7** ("No LLM in V1"). R7 said a later model
  step "may only CLASSIFY into the same closed set, behind its own flag and its own task; a
  model-phrased answer needs its own ADR". This is that ADR. It widens R7 in three named ways
  (§2) and no other.
- **Relates:** [ADR-0043](0043-resume-history-and-chat-update.md) (résumé history, regenerate path) ·
  [ADR-0030](0030-embedding-skill-canonicalization.md) (skill ids, floor 0.75) ·
  [ADR-0042](0042-profile-road-separation.md) (roads) · persona v3.2 (`docs/specs/persona-system-v3.2.md`)
- **Build spec:** [`docs/specs/chat-companion-v2/`](../specs/chat-companion-v2/README.md) — one file per
  phase, plus the shared contracts. Implementers work from the spec; this ADR is the "why".

---

## 1. Context

Companion v1 (ADR-0044) answers a confirmed worker on the Bada Bhai tab with reviewed, fixed copy and a
closed set of deterministic intents. Anything outside that set gets the fallback line. Workers type what
they mean — "Tata ki jagah Mahindra likho", "naya resume banana hai", "welder ke baad kya seekhun" —
and a keyword table cannot follow them.

The owner's design (chat-flow notes, 2026-09-28) routes every free-text message to one of five
worker tasks:

| # | Task | v2 handling | Phase |
|---|---|---|---|
| 1 | Edit résumé | LLM proposes typed field edits; worker confirms on a card; deterministic writers apply | **1** |
| 2 | Career related baatein | LLM answers from its own knowledge, in Hinglish, inside hard refusals | **3** |
| 3 | Jobs related baatein | **Deferred.** Fixed "yeh feature abhi aana baaki hai" line | — |
| 4 | New résumé | Serve the existing redo choices (form / chat / upload) after eligibility checks | **2** |
| 5 | Faltu (trash talk) | Fixed redirect, strike counter, cool-down | **2** |

## 2. Decision

A v2 layer inside the existing leaf module `apps/api/src/chat-companion/`, on the existing route
`POST /chat/companion/message`, plus two additive routes for the edit card. A new AI-service module
`apps/ai-service/app/companion/` holds every model call.

**How R7 is widened — exactly three ways:**

1. **Classify** free text into the closed intent set `{edit_resume, career_talk, jobs_talk,
   new_resume, faltu, unclear}` (Phase 1).
2. **Extract** a typed `EditProposal` from free text (Phase 1). The model names only fields from a
   closed catalogue and rows by opaque refs it was given; deterministic code validates, the worker
   confirms, existing writers apply.
3. **Author** a career answer (Phase 3), inside refusals O10 and output validation.

Everything else in ADR-0044 stands: companion mode is still decided by `ChatCompanionPolicy`; v1's
deterministic intents (chips, résumé menu, jobs, applications, guarantee, status) still run **first**
and still cost zero model calls; the module still never writes `chat_sessions` / `chat_messages`,
never reads the `workers` row, never ranks.

### 2.1 The turn pipeline

```
POST /chat/companion/message
  1. ChatCompanionPolicy        → 409 {mode:"interview"} as today
  2. v2 flag off                → v1 answer, byte-for-byte today's behaviour
  3. Faltu cool-down active     → fixed cool-down line                      (Phase 2)
  4. v1 deterministic resolver  → hit: v1 answer (0 model calls)
  5. Abuse lexicon (isAbusive)  → faltu handler                             (Phase 2)
  6. LLM classifier             → {intent, confidence}; invalid / low → unclear
  7. Intent handler             → turn; intent phase off → "abhi aana baaki hai" + task chips
  8. Strict outbound schema, persona checks, event
```

### 2.2 Owner rulings (2026-09-28)

| # | Ruling |
|---|---|
| **O1** | **Phasing.** Phase 1: router + Edit résumé. Phase 2: New résumé + Faltu. Phase 3: Career talk. |
| **O2** | **Jobs deferred.** A free-text jobs question the router catches gets "yeh feature abhi aana baaki hai" and an invitation to talk about something else. **v1's deterministic jobs answers stay** (recap jobs, "naye jobs" chip). No semantic job search, no impressions. |
| **O3** | **Edit scope:** every profile section **except identity and contact** (name, phone, ID documents). Those point to the settings screen. |
| **O4** | **Edit apply:** one confirm card per proposal ("Pehle X → Ab Y", Haan / Nahi). Nothing is written without the worker's tap. |
| **O5** | **Multi-edit:** one message may carry up to 3 changes; one card lists them; the worker may untick rows before Haan. |
| **O6** | **Regenerate** the résumé after each confirmed card, via the ADR-0043 path with a new trigger `chat_edit`. The existing résumé daily cap applies. |
| **O7** | **Models:** router and edit-extraction on Gemini Flash; career answers on Claude. Existing fallbacks apply. |
| **O8** | **Voice input:** text and voice. Voice reuses the existing upload + transcription pipeline; the transcript is sent as text. |
| **O9** | **Career answers are Hinglish only** (Latin script). No Devanagari twin and **no read-aloud** for model-written replies. Fixed-copy replies keep their reviewed twin and read-aloud. |
| **O10** | **Career refusals** (fixed safe reply instead): salary numbers or job promises; legal / medical / financial advice; named employers or companies; comparing or rating the worker. |
| **O11** | **Faltu:** 3 strikes in a UTC day → 30-minute cool-down (fixed replies only). |
| **O12** | **No per-worker cap on model calls.** Cost is watched (dashboard + alert), not capped. |
| **O13** | **Memory:** last 6 turns, pseudonymized, 30-minute TTL (Redis). Never Postgres. |
| **O14** | **Build now, flags off.** v2 may be built on top of v1 code before v1 is live. |
| **O15** | Design lives in the repo (`docs/specs/chat-companion-v2/`). |
| **O16** | Persona v3.2 Law 2 and the ≤1 "?"/≤20 words/no "!"/no emoji rules bind model-written lines exactly as they bind reviewed copy (enforced by output validation, not trust). |
| **O17** | **Masked values.** The owner intends to remove PII masking platform-wide (a separate decision, outside this ADR: it needs its own ADR, a security review and a CLAUDE.md §3 update). v2 builds **no** token rehydration. v2 calls the existing pseudonymization gateway like every other endpoint; an edit row whose proposed value still carries a placeholder token (`[EMPLOYER_1]`, …) is **dropped** and the worker is pointed to the Profile screen. When masking is removed, no tokens appear and such edits simply work. **→ [ADR-0047](0047-lift-pii-restriction.md)** (2026-09-30): the separate decision, taken. With `AI_RAW_PII_ENABLED` armed, v2 skips the gateway, so no tokens appear; with it off, this ruling holds as written. |

## 3. Invariants (each pinned by a test named in the spec)

- **AI never decides.** The model classifies, extracts and phrases. Deterministic code picks the
  handler, validates every value, and applies writes only after the worker's tap. No ranking.
- **Privacy.** Every model input passes `pseudonymize` in the AI service; the router masks nothing
  itself. No name, phone or ID ever enters a prompt, log, event or trace. Worker text is never logged
  and never put in an event. Redis memory holds pseudonymized text only. _Amended by
  [ADR-0047](0047-lift-pii-restriction.md):_ with `AI_RAW_PII_ENABLED` armed, prompts, the Redis
  memory (O13, still TTL-bound) and traces carry raw text; worker text in logs and events is unchanged.
- **Fail closed.** Any model failure, timeout, schema miss or validation miss → a deterministic
  fallback turn. An edit card is applied in one transaction or not at all.
- **Event first.** Every turn and every edit outcome emits a versioned, `.strict()` event with ids,
  counts and closed enums only (spec: `contracts.md` §4). v1 event schemas are not mutated.
- **Backward compatible.** Only additive wire fields and routes. Old apps never see v2 fields they
  cannot parse. Flag off ⇒ v1 byte-for-byte.
- **Untouched modules.** `ChatService`, `resume-menu.ts`, the interview engine and the profiling
  orchestrator are not edited.

## 4. Consequences

- **Cost.** Model calls happen only on a v1 miss. No per-worker cap (O12); cost is recorded per call
  on the cost ledger (`ai.cost_recorded` + `platform_ai_cost_totals`; an inline call has no `ai_jobs` row, #745) and shown on the admin dashboard; the per-call `cost_alert` flag rides each event, but no push alert exists (TD149). Faltu cool-down bounds abusive loops.
- **Latency.** One classifier call (p95 target < 1.5 s) on a miss; edit extraction adds one more.
- **Schema.** One additive migration: widen `generated_resumes_generation_trigger_chk` with
  `chat_edit` (reserved as `0130`).
- **Residual risk: career answers.** Open-knowledge answers can be wrong. Mitigations: refusals O10,
  output validation, a red-team eval set as a release gate, a kill switch per intent.
- **Deferred:** jobs in chat (semantic search), read-aloud for model text, per-worker cost caps.

```
Owner rulings O1–O17 taken 2026-09-28 in the design session; production flag-ON requires this signature.
Signed (CEO / Prakash): Prakash          Date: 2026-10-05
```
